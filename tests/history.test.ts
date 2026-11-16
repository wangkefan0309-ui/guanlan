import { describe, expect, it } from 'vitest';
import { ReadingLibrary } from '../src/core/library';
import { historyDaySchema, historyDaysSchema } from '../src/core/history';
import { restoreSettings, parseSettings, settingsDefaults } from '../src/core/settings';
import type { FileStore, Material } from '../src/core/model';

class Files implements FileStore {
  data = new Map<string, Uint8Array>(); fail = false; writes: string[] = [];
  async read(path: string) { const bytes = this.data.get(path); return bytes ? new TextDecoder().decode(bytes) : null; }
  async readBinary(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, text: string) { if (this.fail && path.endsWith('/state.json')) throw Error('模拟保存失败'); this.writes.push(path); this.data.set(path, new TextEncoder().encode(text)); }
  async writeBinary(path: string, bytes: Uint8Array) { this.data.set(path, bytes); }
}
const material = (i: number, changes: Partial<Material> = {}): Material => ({
  identity: `https://example.org/history/${i}`, url: `https://example.org/history/${i}`, title: `历史材料 ${i}`, source: `作者 ${i % 3}`,
  kind: 'article', topic: 'ai-learning', purpose: 'reading', publishedAt: `2025-01-${String(i % 28 + 1).padStart(2, '0')}T00:00:00Z`,
  capturedAt: '2026-10-01T00:00:00Z', body: '原文中的具体方法和使用条件。', coverage: 'partial', gaps: [], guide: '', guideKind: 'none',
  original: { extension: 'html', base64: Buffer.from('<article>历史原件</article>').toString('base64') }, ...changes,
});
async function setup(count = 12) {
  let now = '2026-10-19T01:00:00Z'; const files = new Files(), library = new ReadingLibrary(files, '阅读', () => now);
  for (let i = 0; i < count; i++) await library.import(material(i));
  return { files, library, setDay: (day: number) => { now = `2026-10-${String(day).padStart(2, '0')}T01:00:00Z`; } };
}

describe('历史精选的真实材料轮换和保存', () => {
  it('默认两项，覆盖多年历史；当天并发、刷新和重载复用首次清单', async () => {
    const { library, files } = await setup();
    const [first, concurrent] = await Promise.all([library.historyHighlights(), library.historyHighlights({ maxItems: 5 })]);
    expect(first.days[0]!.picks).toHaveLength(2); expect(concurrent).toEqual(first);
    await library.import(material(40, { sourceId: 'WX-004' }));
    const reloaded = new ReadingLibrary(files, '阅读', () => '2026-10-19T12:00:00Z');
    expect((await reloaded.historyHighlights()).days).toEqual(first.days);
  });
  it('逐日轮换到全库，读到一半和高优先级来源不会长期占位', async () => {
    const { library, setDay } = await setup(12); const items = await library.list();
    await library.updateProgress(items[0]!.id, items[0]!.version, 'reading', '第二段');
    const seen = new Set<string>();
    for (let day = 19; day < 25; day++) { setDay(day); const archive = await library.historyHighlights(); for (const pick of archive.days.at(-1)!.picks) { expect(seen.has(pick.id)).toBe(false); seen.add(pick.id); } }
    expect(seen.size).toBe(12);
  });
  it('来源多样；价值位优先在读，轮换位照顾最早积压', async () => {
    const { library } = await setup(6); const items = await library.list();
    await library.updateProgress(items[4]!.id, items[4]!.version, 'reading', '第三段');
    const day = (await library.historyHighlights()).days[0]!;
    expect(day.picks[0]!.id).toBe(items[4]!.id); expect(day.picks[1]!.id).toBe(items[0]!.id);
  });
  it('未读7天、稍后读14天冷却；关闭期间不补建过往日清单', async () => {
    const { library, setDay } = await setup(2); const items = await library.list();
    await library.updateProgress(items[0]!.id, items[0]!.version, 'later');
    await library.historyHighlights(); setDay(20); expect((await library.historyHighlights()).days).toHaveLength(1);
    setDay(26); const archive = await library.historyHighlights(); expect(archive.days).toHaveLength(2);
    expect(archive.days[1]!.picks.map(pick => pick.id)).toEqual([items[1]!.id]);
    expect(archive.days.map(day => day.date)).toEqual(['2026-10-19', '2026-10-26']);
  });
  it('已读立即退出、删除不复活、恢复原引用，当天不自动补位', async () => {
    const { library } = await setup(5); const first = (await library.historyHighlights()).days[0]!, [a, b] = first.picks;
    await library.updateManyProgress([a!.id], 'done'); await library.trashItems([b!.id]);
    expect((await library.historyHighlights()).days[0]).toEqual(first);
    expect((await library.list()).find(item => item.id === a!.id)!.progress).toBe('done');
    await library.restoreItems([b!.id]); expect((await library.historyHighlights()).days[0]).toEqual(first);
  });
  it('同篇多版本只选一次；当日锁定原版本和原路径', async () => {
    const { library } = await setup(1); await library.import(material(0, { body: '第二版实际正文' }));
    const before = await library.list(), day = (await library.historyHighlights()).days[0]!;
    expect(day.picks).toHaveLength(1); expect(day.picks[0]!.version).toBe(before[1]!.version);
    await library.import(material(0, { body: '第三版实际正文' })); expect((await library.historyHighlights()).days[0]).toEqual(day);
  });
  it('拒绝当天、未来、已读、验证材料；未知发布时间按本地保存日候选', async () => {
    const { library, setDay } = await setup(0);
    await library.import(material(1, { publishedAt: '2026-10-19T01:00:00Z' }));
    await library.import(material(2, { publishedAt: '2027-01-01T01:00:00Z' }));
    await library.import(material(3, { purpose: 'validation' }));
    const unknown = await library.import(material(4, { publishedAt: undefined }));
    const done = await library.import(material(5)); await library.updateProgress(done.id, done.version, 'done');
    expect((await library.historyHighlights()).days).toEqual([]);
    setDay(20); expect((await library.historyHighlights({ maxItems: 5 })).days[0]!.picks.map(p => p.id).sort()).toEqual([(await library.list())[0]!.id, unknown.id].sort());
    expect((await library.list()).find(item => item.id === unknown.id)!.publishedAt).toBeUndefined();
  });
  it('元数据视频可推荐原入口；无正文且无链接的材料不冒充可读', async () => {
    const { library } = await setup(0);
    const video = await library.import(material(1, { identity: 'youtube:abc12345678', url: 'https://www.youtube.com/watch?v=abc12345678', body: '', coverage: 'metadata' }));
    await library.import(material(2, { url: undefined, body: '', coverage: 'metadata' }));
    expect((await library.historyHighlights()).days[0]!.picks.map(p => p.id)).toEqual([video.id]);
  });
  it('同日探索去重使用规范化链接；预留历史引用可供后续探索排除', async () => {
    const { library } = await setup(2), items = await library.list();
    const archive = await library.historyHighlights({ excludedUrls: [items[0]!.url! + '#tracking'] });
    expect(archive.days[0]!.picks.map(p => p.id)).toEqual([items[1]!.id]);
    expect(await library.historyUrls()).toEqual([items[1]!.url]);
  });
  it('按账号修正的真实发布日期排除今日材料', async () => {
    const { library } = await setup(0); const item = await library.import(material(1, { sourceId: 'WX-004' }));
    const archive = await library.historyHighlights({ sources: [{ registry_id: 'WX-004', display_name: item.source, publicationDates: { [item.url!]: '2026-10-19T01:00:00Z' } }] });
    expect(archive.days).toEqual([]);
  });
  it('失败不产生幽灵推送，恢复后可保存；正文批注、原件、状态和游标保持', async () => {
    const { library, files } = await setup(3); const items = await library.list();
    await files.write(items[0]!.path, '用户批注需要保留');
    const before = new Map([...files.data].filter(([path]) => !path.endsWith('/state.json')).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]));
    const checkpoint = await library.checkpoint(); files.fail = true;
    await expect(library.historyHighlights()).rejects.toThrow('保存失败');
    const state = JSON.parse((await files.read('阅读/_工作台/state.json'))!); expect(state.historyDays).toEqual([]);
    files.fail = false; expect((await library.historyHighlights()).days).toHaveLength(1);
    expect(await library.list()).toEqual(items); expect(await library.checkpoint()).toEqual(checkpoint);
    for (const [path, bytes] of before) expect(Buffer.from(files.data.get(path)!).toString('base64')).toBe(bytes);
  });
  it('阅读目录隔离、旧索引兼容，索引损坏不伪造清单', async () => {
    const { library, files } = await setup(2); const state = JSON.parse((await files.read('阅读/_工作台/state.json'))!); delete state.historyDays;
    await files.write('阅读/_工作台/state.json', JSON.stringify(state));
    expect((await new ReadingLibrary(files, '阅读', () => '2026-10-19T01:00:00Z').historyHighlights()).days).toHaveLength(1);
    expect((await new ReadingLibrary(files, '另一个目录').historyHighlights()).days).toEqual([]);
    state.historyDays = [{ date: '损坏记录' }]; await files.write('阅读/_工作台/state.json', JSON.stringify(state));
    await expect(new ReadingLibrary(files, '阅读').historyHighlights()).rejects.toThrow();
    expect(library.root).toBe('阅读');
  });
  it('按北京时间自然跨日，当天新材料到次日才进入历史池', async () => {
    const files = new Files(); let now = '2026-10-19T15:59:00Z';
    const library = new ReadingLibrary(files, '阅读', () => now);
    const item = await library.import(material(1, { publishedAt: '2026-10-19T15:00:00Z' }));
    expect((await library.historyHighlights()).days).toEqual([]);
    now = '2026-10-19T16:01:00Z'; const archive = await library.historyHighlights();
    expect(archive.date).toBe('2026-10-20'); expect(archive.days[0]!.picks[0]!.id).toBe(item.id);
  });
  it('空池不锁死当天，后续同步旧材料后自动生成；异步选项捕获首次值', async () => {
    const { library } = await setup(0); expect((await library.historyHighlights()).days).toEqual([]);
    for (let i = 0; i < 5; i++) await library.import(material(i));
    const options = { maxItems: 2, excludedUrls: [] as string[] }, pending = library.historyHighlights(options);
    options.maxItems = 5; options.excludedUrls.push(material(0).url!);
    expect((await pending).days[0]!.picks).toHaveLength(2);
  });
  it('持续新增高优先级文章时，轮换位仍能补到老材料', async () => {
    const { library, setDay } = await setup(8), old = new Set((await library.list()).map(item => item.id));
    const rotated = new Set<string>();
    for (let day = 19; day < 27; day++) {
      setDay(day); for (let n = 0; n < 3; n++) await library.import(material(day * 3 + n, { sourceId: 'WX-004', publishedAt: '2026-10-18T01:00:00Z' }));
      const archive = await library.historyHighlights(); for (const pick of archive.days.at(-1)!.picks) if (old.has(pick.id)) rotated.add(pick.id);
    }
    expect(rotated.size).toBe(old.size);
  });
  it('每日仅一项仍交替兼顾价值和最早积压，不因新文章持续饿死旧材料', async () => {
    const { library, setDay } = await setup(4), old = new Set((await library.list()).map(item => item.id)), seen = new Set<string>();
    for (let day = 19; day < 27; day++) {
      setDay(day);await library.import(material(day + 100, { sourceId: 'WX-004', publishedAt: '2026-10-18T01:00:00Z' }));
      const archive=await library.historyHighlights({maxItems:1});for(const pick of archive.days.at(-1)!.picks)if(old.has(pick.id))seen.add(pick.id);
    }
    expect(seen.size).toBe(old.size);
  });
  it('作者多样性不阻断同作者最早材料的补读', async () => {
    const { library, setDay } = await setup(0);for(let i=0;i<4;i++)await library.import(material(i,{source:'同一作者',topic:'headlines'}));
    const old=new Set((await library.list()).map(item=>item.id)), seen=new Set<string>();
    for(let day=19;day<23;day++){
      setDay(day);const fresh=await library.import(material(day+200,{source:'同一作者',publishedAt:'2026-10-18T01:00:00Z'}));
      await library.updateProgress(fresh.id,fresh.version,'reading');await library.import(material(day+300,{source:'另一个作者',publishedAt:'2026-10-18T01:00:00Z'}));
      for(const pick of (await library.historyHighlights()).days.at(-1)!.picks)if(old.has(pick.id))seen.add(pick.id);
    }
    expect(seen.size).toBe(old.size);
  });
  it('拒绝重复日期/身份和无效日历日期，数量设置默认2且有界', () => {
    const day = { date: '2026-10-19', createdAt: '2026-10-19T01:00:00Z', maxItems: 2, picks: [{ id: 'a'.repeat(64), version: 'b'.repeat(64), reason: '历史轮换' }] };
    expect(historyDaysSchema.safeParse([day, day]).success).toBe(false);
    expect(historyDaySchema.safeParse({ ...day, picks: [...day.picks, ...day.picks] }).success).toBe(false);
    expect(historyDaySchema.safeParse({ ...day, date: '2026-02-31' }).success).toBe(false);
    expect(restoreSettings({ ...settingsDefaults, historyMaxItems: undefined }).settings.historyMaxItems).toBe(2);
    expect(() => parseSettings({ ...settingsDefaults, historyMaxItems: 0 })).toThrow();
  });
});
