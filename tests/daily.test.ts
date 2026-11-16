import { describe, expect, it } from 'vitest';
import { ReadingLibrary } from '../src/core/library';
import { beijingDate, buildReviewBatch, dailyOptionsSchema, DailyReviewSession, itemKey, makeDailyPlan, parseReviewOutput, quoteChoices, reviewContext, shortlist } from '../src/core/daily';
import { parseSettings, restoreSettings, settingsDefaults } from '../src/core/settings';
import type { FileStore, Material } from '../src/core/model';

const now = new Date('2026-10-10T15:59:00.000Z');
class Files implements FileStore {
  data = new Map<string, string>(); fail = ''; failStateOnce = false;
  async read(path: string) { return this.data.get(path) ?? null; }
  async readBinary(path: string) { const text = await this.read(path); return text === null ? null : new TextEncoder().encode(text); }
  async writeBinary(path: string, bytes: Uint8Array) { return this.write(path, new TextDecoder().decode(bytes)); }
  async write(path: string, text: string, expected?: string | null) {
    if (this.fail && path.includes(this.fail)) throw new Error('模拟写入失败');
    if (this.failStateOnce && path.endsWith('state.json')) { this.failStateOnce = false; throw new Error('模拟索引失败'); }
    if (expected !== undefined && await this.read(path) !== expected) throw new Error('文件已被修改');
    this.data.set(path, text);
  }
  async remove(path: string) { this.data.delete(path); }
}
const material = (identity: string, extra: Partial<Material> = {}): Material => ({ title: identity, source: '样例', identity, topic: 'ai-learning', kind: 'article', purpose: 'reading', body: '原文讨论概念与适用条件。'.repeat(30), coverage: 'full', gaps: [], guide: '', guideKind: 'none', capturedAt: now.toISOString(), ...extra });
function response(batch: Awaited<ReturnType<typeof buildReviewBatch>>, extra: Record<string, unknown> = {}) {
  return { content: JSON.stringify({ items: batch.candidates.map(item => ({ key: itemKey(item), label: 'PASS', score: 80, reason: '适合基础学习', guide: '先读原文概念与适用条件，再检查给出的论证。', quote: item.body.slice(0, 20), ...extra })) }), usage: { inputTokens: 1200, outputTokens: 300 } };
}
const makeLibrary = (files = new Files()) => new ReadingLibrary(files, '09_信息源', () => now.toISOString());
const makeBatch = async (library: ReadingLibrary, model = 'flash-test') => buildReviewBatch(await library.list(), dailyOptionsSchema.parse({}), model, 'http://127.0.0.1:1234/v1', now);

describe('每日精选、AI 导读及保存恢复', () => {
  it('限定当天材料时，生成笔记不把旧存档加入清单，旧正文和位置保留',async()=>{
    const files=new Files(),library=makeLibrary(files);
    const old=await library.import(material('旧存档'));await library.updateProgress(old.id,old.version,'reading','旧位置');
    const today=await library.import(material('当天正文'));
    const before=await files.read(old.path);await library.saveDaily({},'',[itemKey(today)]);
    expect(await files.read('09_信息源/今日阅读.md')).toContain('当天正文');expect(await files.read('09_信息源/今日阅读.md')).not.toContain('旧存档');
    expect(await files.read(old.path)).toBe(before);expect((await library.list()).find(item=>item.id===old.id)?.position).toBe('旧位置');
  });
  it('按板块搭配并优先继续阅读，预算与篇数都受限制，不把旧资讯或视频当正文', async () => {
    const library = makeLibrary();
    const reading = await library.import(material('正在读')); await library.updateProgress(reading.id, reading.version, 'reading', '第二段');
    for (let i = 0; i < 8; i++) await library.import(material(`AI-${i}`, { capturedAt: new Date(now.getTime() + i).toISOString() }));
    await library.import(material('财经', { topic: 'finance' })); await library.import(material('法律', { topic: 'law' }));
    await library.import(material('旧资讯', { topic: 'ai-news', publishedAt: '2026-09-01' }));
    await library.import(material('老知识', { topic: 'finance', publishedAt: '2020-01-01' }));
    await library.import(material('视频', { identity: 'youtube:abc', topic: 'leisure', coverage: 'metadata', body: '' }));
    const plan = makeDailyPlan(await library.list(), { budgetMinutes: 5, maxItems: 3 }, [], '', now);
    expect(plan.picks[0]?.item.id).toBe(reading.id); expect(new Set(plan.picks.map(pick => pick.item.topic)).size).toBe(3);
    expect(plan.totalMinutes).toBeLessThanOrEqual(5); expect(plan.picks.map(pick => pick.item.title)).not.toContain('旧资讯');
    expect(plan.missingTopics).toEqual([]); expect(plan.mode).toBe('rules');
  });
  it('平衡最多12篇候选，不发验证材料、已读、稍后读、无正文或历史版本', async () => {
    const library = makeLibrary();
    for (let i = 0; i < 20; i++) await library.import(material(`ai-${i}`));
    await library.import(material('财经', { topic: 'finance' })); await library.import(material('法律', { topic: 'law' }));
    await library.import(material('验证', { purpose: 'validation' }));
    const later = await library.import(material('稍后')); await library.updateProgress(later.id, later.version, 'later');
    const done = await library.import(material('已读')); await library.updateProgress(done.id, done.version, 'done');
    const first = await library.import(material('新版材料')); await library.import(material('新版材料', { body: '更新后的原文。' }));
    const pool = shortlist(await library.list(), now); expect(pool).toHaveLength(12);
    expect(pool.map(item => item.topic)).toContain('finance'); expect(pool.map(item => item.topic)).toContain('law');
    expect(pool.map(itemKey)).not.toContain(itemKey(first));
    expect(pool.every(item => !['验证', '稍后', '已读'].includes(item.title))).toBe(true);
  });
  it('模型仅收到截取的正文，发布时间未知与缺口明确，伪造引文及重复标识拒绝保存', async () => {
    const library = makeLibrary(); await library.import(material('长文', { body: '正文'.repeat(3000) + '不应发送的末尾', coverage: 'partial', gaps: ['图表缺失'] }));
    const batch = await makeBatch(library); const messages = JSON.stringify(batch.messages);
    expect(messages).not.toContain('不应发送的末尾'); expect(messages).toContain('图表缺失'); expect(messages).toContain('采集时间不是发布时间');
    expect(parseReviewOutput(response(batch).content, batch)[0]?.sampledChars).toBe(2400);
    expect(() => parseReviewOutput(response(batch, { quote: '伪造证据' }).content, batch)).toThrow('正文摘选');
    const duplicate = JSON.parse(response(batch).content); duplicate.items.push(duplicate.items[0]); expect(() => parseReviewOutput(JSON.stringify(duplicate), batch)).toThrow('数量');
    expect(parseReviewOutput(response(batch, { label: 'BLOCK' }).content, batch)[0]?.label).toBe('UNKNOWN');
  });
  it('导读独立保存、关联版本、记录用量，重复生成复用回执且不改正文和原件', async () => {
    const files = new Files(); const library = makeLibrary(files); const item = await library.import(material('知识')); const body = await files.read(item.path);
    const batch = await makeBatch(library); let calls = 0; const answer = async () => { calls++; return response(batch); };
    const path = await new DailyReviewSession(library).run(batch, 1, answer);
    const restarted = makeLibrary(files); expect(await new DailyReviewSession(restarted).run(batch, 1, answer)).toBe(path); expect(calls).toBe(1);
    expect(await files.read(item.path)).toBe(body); expect(await files.read(path)).toContain('输入 1200 tokens');
    const receipts = await restarted.reviews(); const plan = makeDailyPlan(await restarted.list(), {}, receipts, batch.receipt.contextHash, now);
    expect(plan.mode).toBe('ai'); expect(plan.picks[0]?.review?.guide).toContain('先读原文');
    await restarted.saveDaily({}, batch.receipt.contextHash); expect(await files.read('09_信息源/今日阅读.md')).toContain('AI 导读（flash-test');
    expect(makeDailyPlan(await restarted.list(), {}, receipts, await reviewContext('新学习目标', 'flash-test', batch.receipt.endpoint), now).mode).toBe('rules');
  });
  it('模型选择原文编号，标点与换行由程序原样保存；越界编号和附加改写引文被拒绝', async () => {
    const library = makeLibrary();
    const body = '原句含“中文引号”、English punctuation!\n\n与 [原文链接](https://example.com/a)。'.repeat(60);
    await library.import(material('混合排版', { body }));
    const batch = await makeBatch(library); const input = JSON.parse(batch.messages[1]!.content).materials[0];
    expect(input.quoteChoices).toHaveLength(8); expect(input.quoteChoices.every((choice: { text: string }) => body.slice(0, 2400).includes(choice.text))).toBe(true);
    const output = JSON.parse(response(batch).content); delete output.items[0].quote; output.items[0].quoteIndex = 7;
    const parsed = parseReviewOutput(JSON.stringify(output), batch)[0]!;
    expect(parsed.quote).toBe(quoteChoices(body)[7]); expect(parsed.quote.length).toBeLessThanOrEqual(160);
    output.items[0].quoteIndex = 8; expect(() => parseReviewOutput(JSON.stringify(output), batch)).toThrow();
    output.items[0].quoteIndex = 0; output.items[0].quote = '偷偷改写'; expect(() => parseReviewOutput(JSON.stringify(output), batch)).toThrow();
    await library.import(material('短正文', { body: '只有一句原文。' }));
    const short = await makeBatch(library); const invalid = JSON.parse(response(short).content);
    const entry = invalid.items.find((item: { key: string }) => item.key === itemKey(short.candidates.find(item => item.title === '短正文')!));
    delete entry.quote; entry.quoteIndex = 1; expect(() => parseReviewOutput(JSON.stringify(invalid), short)).toThrow('正文摘选');
  });
  it('无效付费输出保留原始回答与用量，重启后不作为导读、不再次调用', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library); let calls = 0;
    const invalid = response(batch, { quote: '模型改写原句' });
    await expect(new DailyReviewSession(library).run(batch, 1, async () => { calls++; return invalid; })).rejects.toThrow('正文摘选');
    const path = `09_信息源/_工作台/模型回执/AI-${batch.receipt.fingerprint}.json`;
    const receipt = JSON.parse((await files.read(path))!); expect(receipt.validation).toBe('failed'); expect(receipt.response).toEqual(invalid);
    expect(receipt.request.model).toBe('flash-test'); expect((await library.reviews())[0]?.usage).toEqual(invalid.usage);
    const restarted = makeLibrary(files); expect(makeDailyPlan(await restarted.list(), {}, await restarted.reviews(), batch.receipt.contextHash, now).mode).toBe('rules');
    await expect(new DailyReviewSession(restarted).run(batch, 5, async () => { calls++; return response(batch); })).rejects.toThrow('已发起'); expect(calls).toBe(1);
  });
  it('无效输出回执保存失败后只补存首次回答，用量和调用配置不受新批次影响', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library); let calls = 0;
    const session = new DailyReviewSession(library); files.fail = '/模型回执/';
    await expect(session.run(batch, 1, async () => { calls++; return response(batch, { quote: '无效引用' }); })).rejects.toThrow('写入失败');
    expect(session.pendingRejected?.receipt.model).toBe('flash-test'); files.fail = '';
    await expect(session.run(await makeBatch(library, 'changed-model'), 1, async () => { calls++; throw new Error('不得重发'); })).rejects.toThrow('校验失败');
    expect(session.pendingRejected).toBeNull(); expect((await library.reviews())[0]?.model).toBe('flash-test'); expect(calls).toBe(1);
  });
  it('每日上限计入失败调用，重启/下一天不自动重发同一未知批次', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library); let calls = 0;
    await expect(new DailyReviewSession(library).run(batch, 1, async () => { calls++; throw new Error('结果未知'); })).rejects.toThrow('结果未知');
    const restarted = makeLibrary(files);
    await expect(new DailyReviewSession(restarted).run(batch, 5, async () => { calls++; return response(batch); })).rejects.toThrow('已发起');
    const changed = await makeBatch(restarted, 'changed-model');
    await expect(new DailyReviewSession(restarted).run(changed, 1, async () => { calls++; return response(changed); })).rejects.toThrow('上限');
    expect(calls).toBe(1); expect((await restarted.reviews())[0]?.error).toBe('结果未知');
    const nextDay = new Date('2026-10-11T16:00:00.000Z');
    const laterLibrary = new ReadingLibrary(files, '09_信息源', () => nextDay.toISOString());
    const laterBatch = await buildReviewBatch(await laterLibrary.list(), dailyOptionsSchema.parse({}), batch.receipt.model, batch.receipt.endpoint, nextDay);
    await expect(new DailyReviewSession(laterLibrary).run(laterBatch, 1, async () => { calls++; return response(laterBatch); })).rejects.toThrow('已发起'); expect(calls).toBe(1);
  });
  it('AI 全部排除时少推并如实标记 AI 筛选，更新正文后不复用旧评分', async () => {
    const library = makeLibrary(); await library.import(material('财经评论', { topic: 'finance' })); const batch = await makeBatch(library);
    await new DailyReviewSession(library).run(batch, 1, async () => response(batch, { label: 'BLOCK', score: 0, reason: '与目标无关' }));
    const plan = makeDailyPlan(await library.list(), {}, await library.reviews(), batch.receipt.contextHash, now);
    expect(plan.picks).toEqual([]); expect(plan.mode).toBe('ai'); expect(plan.missingTopics).toContain('财经金融');
    await library.import(material('财经评论', { topic: 'finance', body: '新正文包含基础概念。' }));
    const updated = makeDailyPlan(await library.list(), {}, await library.reviews(), batch.receipt.contextHash, now);
    expect(updated.mode).toBe('rules'); expect(updated.picks[0]?.item.body).toBe('新正文包含基础概念。');
  });
  it('调用前回执写入失败不发请求，模型返回后保存失败只补保存且保留原模型', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library); let calls = 0;
    files.fail = 'state.json'; const session = new DailyReviewSession(library);
    await expect(session.run(batch, 1, async () => { calls++; return response(batch); })).rejects.toThrow('写入失败'); expect(calls).toBe(0);
    files.fail = '';
    await expect(session.run(batch, 1, async () => { calls++; files.fail = '/AI导读/'; return response(batch); })).rejects.toThrow('写入失败');
    expect(session.pendingSave?.model).toBe('flash-test'); files.fail = '';
    await session.run(await makeBatch(library, 'changed-model'), 1, async () => { calls++; throw new Error('不得重发'); });
    expect(calls).toBe(1); expect((await library.reviews())[0]?.model).toBe('flash-test'); expect(session.pendingSave).toBeNull();
  });
  it('落盘后的回答在重启时补交索引，用户改过的导读与今日清单保留', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library); let calls = 0;
    const write = files.write.bind(files); files.write = async (path, text, expected) => { await write(path, text, expected); if (path.includes('/AI导读/')) files.failStateOnce = true; };
    await expect(new DailyReviewSession(library).run(batch, 1, async () => { calls++; return response(batch); })).rejects.toThrow('索引失败');
    files.write = write; const restarted = makeLibrary(files);
    const path = await new DailyReviewSession(restarted).run(batch, 1, async () => { calls++; throw new Error('不得重发'); }); expect(calls).toBe(1);
    await restarted.saveDaily({}, batch.receipt.contextHash); await files.write('09_信息源/今日阅读.md', '我的清单');
    await expect(restarted.saveDaily({}, batch.receipt.contextHash)).rejects.toThrow('已被修改'); expect(await files.read('09_信息源/今日阅读.md')).toBe('我的清单');
    // A new completed result may never overwrite a user's independent AI note.
    await files.write(path, '我的导读批注');
    await expect(restarted.finishReview((await restarted.reviews())[0]!)).rejects.toThrow('已被修改'); expect(await files.read(path)).toBe('我的导读批注');
  });
  it('并发生成只请求一次，保存与等待期间其他材料的进度不丢失', async () => {
    const library = makeLibrary(); const item = await library.import(material('知识')); const batch = await makeBatch(library); let finish!: (value: ReturnType<typeof response>) => void; let calls = 0;
    const session = new DailyReviewSession(library); const answer = () => { calls++; return new Promise<ReturnType<typeof response>>(resolve => { finish = resolve; }); };
    const first = session.run(batch, 1, answer); const second = session.run(batch, 1, answer); expect(first).toBe(second);
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    await library.updateProgress(item.id, item.version, 'reading', '第二段'); finish(response(batch)); await first;
    expect(calls).toBe(1); expect((await library.list())[0]?.position).toBe('第二段');
  });
  it('旧配置升级移除陪读凭据、保留轻处理，无效预算恢复且北京日期不随宿主时区', () => {
    const restored = restoreSettings({ directory: '09_旧目录', model: 'deep-model', modelKey: 'old-key', dailyBudget: -1 });
    expect(restored.settings.directory).toBe('09_旧目录'); expect(restored.settings).not.toHaveProperty('modelKey'); expect(restored.migrated).toBe(true); expect(restored.settings.guideKey).toBe(''); expect(restored.settings.dailyBudget).toBe(50);
    expect(restored.settings.autoDailyAi).toBe(false); expect(restoreSettings({ autoDailyAi: true }).settings.autoDailyAi).toBe(true);
    expect(() => parseSettings({ ...settingsDefaults, dailyAiLimit: 999 })).toThrow(); expect(() => parseSettings({ ...settingsDefaults, guideUrl: 'http://remote.example.com' })).toThrow('HTTPS');
    expect(beijingDate(new Date('2026-10-10T16:01:00Z'))).toBe('2026-10-11');
  });
  it('被篡改的导读路径不进入缓存，恢复记录不得冒充其他模型', async () => {
    const files = new Files(); const library = makeLibrary(files); await library.import(material('知识')); const batch = await makeBatch(library);
    await library.beginReview(batch.receipt, 1);
    const pending = { ...batch.receipt, status: 'completed', entries: parseReviewOutput(response(batch).content, batch), model: '伪造模型' };
    await files.write(`09_信息源/_工作台/待提交/AI-${batch.receipt.fingerprint}.json`, JSON.stringify(pending));
    await expect(makeLibrary(files).beginReview(batch.receipt, 1)).rejects.toThrow('恢复记录不匹配');
    const state = JSON.parse((await files.read('09_信息源/_工作台/state.json'))!); state.reviews[0].path = '08_LLM Wiki/elsewhere.md';
    await files.write('09_信息源/_工作台/state.json', JSON.stringify(state)); await expect(makeLibrary(files).list()).rejects.toThrow('越过');
  });
});
