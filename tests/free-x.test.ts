import { expect, it } from 'vitest';
import { FreeXDiscovery, type FreeXRuntime } from '../src/server/free-x';
import { discoveryTopicIds } from '../src/core/discovery-topics';
import { mergeExplorationSearch } from '../src/core/exploration-merge';
import { restoreSettings } from '../src/core/settings';
import type { FileStore } from '../src/core/model';

class Files implements FileStore {
  data = new Map<string, string>(); fail = '';
  async read(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, text: string) { if (this.fail && path.includes(this.fail)) throw new Error('disk'); this.data.set(path, text); }
  async readBinary() { return null; } async writeBinary() { throw new Error('unused'); }
}
const start = new Date('2026-10-12T02:00:00Z');
const input = { topics: [...discoveryTopicIds] };
const post = (id: number) => ({ id_str: String(id), full_text: '这一条是模拟的真实帖子正文，用于检查日期范围、互动观测、回执保存及失败后不会重复搜索。', tweet_created_at: start.toISOString(), user: { screen_name: 'author' }, favorite_count: 50, retweet_count: 4, reply_count: 2 });
const payload = (offset = 0) => JSON.stringify({ ok: true, tweets: Array.from({ length: 20 }, (_, index) => post(offset + index + 10000)), raw: { fixture: true } });
const runtime = (search: FreeXRuntime['search'], configured = true): FreeXRuntime => ({ search, async ready() { return { configured, reason: '请连接X账号' }; }, async login() {} });

it('未登录不搜索、不占当日批次，登录后可开始；旧Key不会自动选择付费渠道', async () => {
  const files = new Files(); let calls = 0;
  const missing = new FreeXDiscovery(files, runtime(async () => { calls++; return payload(); }, false), () => start);
  expect((await missing.search(input)).warnings[0]).toContain('连接'); expect(calls).toBe(0); expect(files.data.size).toBe(0);
  const connected = new FreeXDiscovery(files, runtime(async () => { calls++; return payload(); }), () => start);
  await connected.search({ topics: ['technology'] }); expect(calls).toBe(1);
  const restored = restoreSettings({ socialDataKey: 'old-key' }).settings;
  expect(restored.xProvider).toBe('free'); expect(restored.socialDataKey).toBe('old-key');
});
it('同日并发和重启共享最多三个首页，候选轮流取样、保留日期互动与原件，不产生付费用量', async () => {
  const files = new Files(); let calls = 0;
  const api = new FreeXDiscovery(files, runtime(async query => { expect(query).toContain('since_time:'); expect(query).not.toContain('cursor'); return payload(++calls * 100); }), () => start);
  const [first, second] = await Promise.all([api.search(input), api.search({ topics: ['life'] })]);
  expect(calls).toBe(3); expect(first.candidates).toHaveLength(9); expect(first.snapshots).toHaveLength(3);
  expect(first.candidates[0]?.engagement).toMatchObject({ likes: 50, reposts: 4, replies: 2 });
  expect(first.freeXUsage).toMatchObject({ returnedPosts: 60, requestsToday: 3, cached: false }); expect(first.xUsage).toBeUndefined();
  expect(second.freeXUsage?.cached).toBe(true);
  const reboot = new FreeXDiscovery(files, runtime(async () => { throw new Error('禁止重发'); }), () => start);
  const replay = await reboot.search(input); expect(replay.candidates).toHaveLength(9); expect(replay.snapshots).toHaveLength(3); expect((await reboot.status()).verified).toBe(true);
  const merged = mergeExplorationSearch({ candidates: [], warnings: [], snapshots: [], credits: 0 }, first);
  expect(merged.freeXUsage?.returnedPosts).toBe(60); expect(merged.xUsage).toBeUndefined();
});

it('旧日缓存从原件恢复视频时长，区分四小时原片与预告，不搜索；收录完整帖文并隔离Markdown语法', async () => {
  const files = new Files(); let calls = 0;
  const full = { ...post(10000), full_text: '对话孙宇晨：年轻人如何抓住AI时代的机会？ '.repeat(150) + '\n![[Rocker]]\n<script>bad</script>\n# 标题' };
  const preview = { ...post(10001), full_text: '四小时播客明天发布，这是预告而非正式节目。 '.repeat(3) };
  const api = new FreeXDiscovery(files, runtime(async () => { calls++; return JSON.stringify({ ok: true, tweets: [full, preview], raw: { data: [
    { rest_id: '10000', legacy: { extended_entities: { media: [{ type: 'video', video_info: { duration_millis: 15749336 } }] } } },
    { rest_id: '10001', legacy: { extended_entities: { media: [{ type: 'video', video_info: { duration_millis: 42633 } }] } } },
  ] } }); }), () => start);
  await api.search({ topics: ['technology'] });
  const state = JSON.parse(files.data.get('free-x/state.json')!); for (const item of state.batches[0].result.candidates) { delete item.media; delete item.contentLinks; }
  files.data.set('free-x/state.json', JSON.stringify(state));
  const reboot = new FreeXDiscovery(files, runtime(async () => { throw new Error('禁止搜索'); }), () => start);
  const replay = await reboot.search(input);
  expect(replay.candidates.map(item => item.media?.durationSeconds)).toEqual([15749, 42]); expect(calls).toBe(1);
  const before = JSON.stringify([...files.data]);
  const material = await reboot.post({ url: 'https://twitter.com/AUTHOR/status/10000/video/1?s=20', topic: 'finance' });
  expect(material.topic).toBe('finance'); expect(material.url).toBe('https://x.com/author/status/10000'); expect(material.body!.length).toBeGreaterThan(2400);
  expect(material.body).toContain('\\!\\[\\[Rocker\\]\\]'); expect(material.body).toContain('\\<script\\>');
  const original = Buffer.from(material.original!.base64, 'base64').toString('utf8');
  const record = JSON.parse(original.split('```json\n')[1]!.split('\n```')[0]!);
  expect(record.tweet.full_text).toBe(full.full_text); expect(record.original.legacy.extended_entities.media[0].video_info.duration_millis).toBe(15749336);
  expect(material.gaps.join(' ')).toContain('视频文字稿'); expect(JSON.stringify([...files.data])).toBe(before);
  await expect(reboot.post({ url: 'https://x.com/imposter/status/10000' })).rejects.toThrow('作者');
  await expect(reboot.post({ url: 'https://x.com/author/status/9999' })).rejects.toThrow('未找到');
  await expect(reboot.post({ url: 'https://x.com.attacker.test/author/status/10000' })).rejects.toThrow('真实X');
  const receipt = [...files.data.keys()].find(path => path.includes('receipts'))!; files.data.set(receipt, '{}');
  await expect(reboot.post({ url: full.user.screen_name && 'https://x.com/author/status/10000' })).rejects.toThrow('校验');
  expect(calls).toBe(1);
});

it('跨天恢复采集与同日缓存分开；注销后仍可收录已校验公开原件，失败不回退付费', async () => {
  const files = new Files(); let now=start, calls=0, configured=true;
  const client = { async ready() { return { configured, reason: 'login-required' }; }, async login() {}, async search() { calls++; return JSON.stringify({ ok:true, tweets:[post(10000+calls)], raw:{} }); } };
  const api = new FreeXDiscovery(files,client,()=>now);
  await api.search({ topics:['technology'] }); expect(calls).toBe(1);
  configured=false;
  expect((await api.search(input)).candidates).toHaveLength(1);
  expect((await api.post({url:'https://x.com/author/status/10001'})).body).toBe(post(10001).full_text);
  now=new Date(start.getTime()+86400_000);
  expect((await api.search(input)).candidates).toHaveLength(0); expect((await api.status()).requestsToday).toBe(0);
  configured=true; await api.search(input); expect(calls).toBe(4); expect((await api.status()).returnedPosts).toBe(3);
  await new FreeXDiscovery(files,client,()=>now).search(input); expect(calls).toBe(4);
});

it('未进入九条候选的已抓取帖子仍可按原件收录，旧回执没有ID索引时兼容', async () => {
  const files=new Files();let calls=0;const api=new FreeXDiscovery(files,runtime(async()=>{calls++;return payload();}),()=>start);
  const result=await api.search({topics:['technology']});expect(result.candidates).toHaveLength(9);
  expect((await api.post({url:'https://x.com/author/status/10019'})).body).toBe(post(10019).full_text);
  const state=JSON.parse(files.data.get('free-x/state.json')!);delete state.batches[0].attempts[0].postIds;files.data.set('free-x/state.json',JSON.stringify(state));
  const reboot=new FreeXDiscovery(files,runtime(async()=>{throw new Error('禁止补抓');}),()=>start);
  expect((await reboot.post({url:'https://x.com/author/status/10019'})).body).toBe(post(10019).full_text);expect(calls).toBe(1);
});
it('失败与未知超时停止余下搜索，同日重登或重启不自动重发，次日可再次检查', async () => {
  const files = new Files(); let calls = 0, now = start;
  const client = runtime(async () => { calls++; throw new Error('timeout'); });
  const api = new FreeXDiscovery(files, client, () => now);
  expect((await api.search(input)).freeXUsage?.paused).toBe(true); expect(calls).toBe(1);
  await api.login(); await api.search(input); await new FreeXDiscovery(files, client, () => now).search(input); expect(calls).toBe(1);
  now = new Date(start.getTime() + 86400_000); await api.search(input); expect(calls).toBe(2);
});
it('部分成功后失败保留已取得原件与候选；空结果是成功检查但不冒充抓取已验证', async () => {
  let calls = 0;
  const api = new FreeXDiscovery(new Files(), runtime(async () => ++calls === 1 ? payload() : JSON.stringify({ ok: false, reason: 'expired' })), () => start);
  const result = await api.search(input); expect(calls).toBe(2); expect(result.candidates).toHaveLength(9); expect(result.snapshots).toHaveLength(1); expect(result.freeXUsage?.paused).toBe(true);
  const empty = new FreeXDiscovery(new Files(), runtime(async () => JSON.stringify({ ok: true, tweets: [], raw: {} })), () => start);
  await empty.search({ topics: ['technology'] }); expect((await empty.status()).verified).toBe(false); expect((await empty.status()).paused).toBe(false);
});
it('日期缺失、过期与未来帖不进入近七天候选；缺失互动不编造零', async () => {
  const missing = { ...post(10000), favorite_count: null };
  const tweets = [missing, { ...post(10001), tweet_created_at: null }, { ...post(10002), tweet_created_at: '2020-01-01T00:00:00Z' }, { ...post(10003), tweet_created_at: '2027-01-01T00:00:00Z' }];
  const api = new FreeXDiscovery(new Files(), runtime(async () => JSON.stringify({ ok: true, tweets, raw: {} })), () => start);
  const result = await api.search({ topics: ['technology'] }); expect(result.candidates).toHaveLength(1); expect(result.candidates[0]?.engagement).toBeUndefined(); expect(result.freeXUsage?.returnedPosts).toBe(4);
});
it('写入失败仅重试保存首次回执；进程重启保留已记请求，不重发', async () => {
  const files = new Files(); let calls = 0;
  const client = runtime(async () => { calls++; return payload(); });
  const api = new FreeXDiscovery(files, client, () => start); files.fail = 'receipts';
  await expect(api.search(input)).rejects.toThrow('disk'); expect(calls).toBe(1);
  files.fail = ''; const recovered = await api.search(input); expect(calls).toBe(1); expect(recovered.candidates).toHaveLength(9); expect(recovered.freeXUsage?.paused).toBe(true);
  const interrupted = new Files(); interrupted.fail = 'receipts';
  await expect(new FreeXDiscovery(interrupted, client, () => start).search(input)).rejects.toThrow(); interrupted.fail = '';
  const before = calls; const reboot = await new FreeXDiscovery(interrupted, client, () => start).search(input); expect(calls).toBe(before); expect(reboot.freeXUsage?.paused).toBe(true);
});
it('原件损坏阻止回放且不补发；非法请求不调用外部库', async () => {
  const files = new Files(); let calls = 0;
  const api = new FreeXDiscovery(files, runtime(async () => { calls++; return payload(); }), () => start);
  await api.search({ topics: ['technology'] }); const receipt = [...files.data.keys()].find(path => path.includes('receipts'))!; files.data.set(receipt, '{}');
  expect(await api.status()).toMatchObject({ verified: false, paused: true });
  await expect(api.search(input)).rejects.toThrow('校验'); await expect(api.search({ ...input, key: 'not-accepted' })).rejects.toThrow(); expect(calls).toBe(1);
});
