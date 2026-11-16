import { describe, expect, it } from 'vitest';
import { fetchBilibiliFeed, bilibiliFeedFromJson } from '../src/server/bilibili';
import { createBilibiliBrowserReader } from '../src/server/bilibili-browser';
import { parseRss } from '../src/server/rss';
import { subscriptionUpdateSchema } from '../src/core/subscriptions';
import { defaultSubscriptions } from '../src/core/source-registry';
import { SubscriptionCollector } from '../src/server/subscriptions';
import type { FileStore, Material } from '../src/core/model';
import { sourceProxy } from '../src/server/source-proxy';

const channel = 'UCFDMMIHbtRdrVhHlGXVzApA';
const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>老周横眉</title><author><name>老周横眉</name><uri>https://www.youtube.com/channel/${channel}</uri></author><entry><yt:videoId>12345678901</yt:videoId><title>视频测试</title><link rel="alternate" href="https://www.youtube.com/watch?v=12345678901"/><author><uri>https://www.youtube.com/channel/${channel}</uri></author><published>2026-10-10T01:00:00Z</published></entry></feed>`;
const nav = JSON.stringify({ data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${'a'.repeat(32)}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${'b'.repeat(32)}.png` } } });
const archives = { code: 0, data: { page: { count: 1 }, list: { vlist: [{ mid: 946974, bvid: 'BV1234567890', title: '影视飓风测试', author: '影视飓风', created: 1791594000 }] } } };
describe('跨平台来源订阅', () => {
  it('补齐同一投稿窗口复用成功结果，五分钟后再读取；不缓存失败也不混用UID', async () => {
    let at = 0, calls = 0, fail = false;
    const reader = createBilibiliBrowserReader('test-chrome', async uid => { calls++; if (fail) throw new Error('412'); return { status: 200, body: uid, url: `https://space.bilibili.com/${uid}`, collectionMethod: 'browser' }; }, () => at);
    await reader('946974'); await reader('946974');
    expect(calls).toBe(1);
    at = 300_000; fail = true;
    await expect(reader('946974')).rejects.toThrow('412');
    await expect(reader('946974')).rejects.toThrow('412');
    expect(calls).toBe(3);
    fail = false; await reader('946974'); await reader('1');
    expect(calls).toBe(5);
    await expect(reader('946974', AbortSignal.abort())).rejects.toThrow();
    expect(calls).toBe(5);
  });
  it('B站 RSS 503 后用本机公开页补抓，重复检查不重复保存', async () => {
    const texts = new Map<string, string>();
    const files = { read: async (path: string) => texts.get(path) ?? null, write: async (path: string, value: string) => { texts.set(path, value); } } as FileStore;
    const saved: Material[] = [];
    let browserCalls = 0;
    const feed = await fetchBilibiliFeed('946974', undefined, async url => url.pathname.endsWith('/nav') ? nav : JSON.stringify(archives));
    const collector = new SubscriptionCollector({ files, save: async material => { saved.push(material); return true; }, readFeed: async () => { throw new Error('订阅返回 HTTP 503'); },
      ...{ readBilibiliBrowser: async (uid: string, signal?: AbortSignal) => { expect(uid).toBe('946974'); expect(signal?.aborted).toBe(false); browserCalls++; return { ...feed, collectionMethod: 'browser' as const }; } } });
    const initial = await collector.list();
    const config = initial.sources.find(source => source.config.id === 'BL-001')!.config;
    await collector.configure({ collectionScope: 'feed-window', revision: initial.revision, sources: [{ ...config, enabled: true, topic: 'leisure', feedUrl: 'http://127.0.0.1:1200/bilibili/user/video/946974/noembed' }] });
    await collector.poll(true);
    expect((await collector.list()).sources[0]!.status).toBe('ok');
    expect((await collector.list()).sources[0]!.collectionMethod).toBe('browser');
    await collector.poll(true);
    expect(browserCalls).toBe(2);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ identity: 'bilibili:BV1234567890', coverage: 'metadata', body: '' });
    expect([...texts.keys()].some(path => path.endsWith('.json') && path.startsWith('subscription-snapshots/'))).toBe(true);
  });
  it('公开页不能把错误、假空列表、错误UID或无效时间当作成功', () => {
    const bad = [{ code: -352 }, { code: 0, data: { list: { vlist: [] } } },
      ...[{ mid: 1 }, { title: ' ' }, { created: 1e15 }].map(fields => ({ ...archives, data: { list: { vlist: [{ ...archives.data.list.vlist[0], ...fields }] } } }))];
    for (const response of bad) expect(() => bilibiliFeedFromJson('946974', JSON.stringify(response))).toThrow();
    expect(() => bilibiliFeedFromJson('../946974', JSON.stringify(archives))).toThrow();
    expect(() => bilibiliFeedFromJson('946974', ' '.repeat(2_000_001))).toThrow();
  });
  it('两个采集方式都失败保留回执并退避，YouTube不会误用B站回退', async () => {
    const texts = new Map<string, string>();
    const files = { read: async (path: string) => texts.get(path) ?? null, write: async (path: string, value: string) => { texts.set(path, value); } } as FileStore;
    let browserCalls = 0;
    const collector = new SubscriptionCollector({ files, now: () => new Date('2026-10-11T08:00:00Z'), save: async () => { throw new Error('失败不能保存'); }, readFeed: async () => { throw new Error('HTTP 503'); }, readBilibiliBrowser: async () => { browserCalls++; throw new Error('公开页HTTP 412'); } });
    const initial = await collector.list();
    await collector.configure({ collectionScope: 'feed-window', revision: initial.revision, sources: initial.sources.filter(source => ['BL-001', 'YT-001'].includes(source.config.id)).map(source => ({ ...source.config, enabled: true, topic: 'leisure', feedUrl: source.config.platform === 'bilibili' ? 'http://127.0.0.1:1200/bilibili/user/video/946974/noembed' : 'https://www.youtube.com/feeds/videos.xml' })) });
    await collector.poll(true);
    expect(browserCalls).toBe(1);
    for (const source of (await collector.list()).sources) expect(source).toMatchObject({ status: 'error', lastSuccess: null,
      nextDue: source.config.platform === 'bilibili' ? '2026-10-11T08:05:00.000Z' : '2026-10-11T08:01:00.000Z' });
  });
  it('停止采集时不会启动新的浏览器回退', async () => {
    const texts = new Map<string, string>();
    const files = { read: async (path: string) => texts.get(path) ?? null, write: async (path: string, value: string) => { texts.set(path, value); } } as FileStore;
    let browserCalls = 0, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const collector = new SubscriptionCollector({ files, save: async () => true, readFeed: async (_url, { signal }) => { started(); await new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true })); signal?.throwIfAborted(); throw new Error('停止'); }, readBilibiliBrowser: async () => { browserCalls++; throw new Error('不得调用'); } });
    const initial = await collector.list();
    const config = initial.sources.find(source => source.config.id === 'BL-001')!.config;
    await collector.configure({ collectionScope: 'feed-window', revision: initial.revision, sources: [{ ...config, enabled: true, topic: 'leisure', feedUrl: 'http://127.0.0.1:1200/bilibili/user/video/946974/noembed' }] });
    const polling = collector.poll(true);
    await entered; await collector.stop(); await polling;
    expect(browserCalls).toBe(0);
    expect((await collector.list()).sources[0]!).toMatchObject({ status: 'error', nextDue: null });
  });
  it('代理仅用于固定来源主机，不用于本机、任意链接或非标准端口', () => {
    const proxy = 'http://127.0.0.1:7897';
    expect(sourceProxy(new URL('https://www.youtube.com/feeds/videos.xml'), proxy)).toBeDefined();
    for (const url of ['http://127.0.0.1/feed', 'https://example.org/feed', 'https://www.youtube.com:8443/feed']) expect(sourceProxy(new URL(url), proxy)).toBeUndefined();
  });
  it('十五个选定来源保留旧配置，并包括用户新增的三个YouTube频道', () => {
    const configs = defaultSubscriptions();
    expect(configs).toHaveLength(15);
    expect(configs.filter(source => source.platform === 'youtube').map(source => source.name)).toEqual(['老周横眉', '小Lin说', '硅谷101', '3Blue1Brown']);
    const revision = crypto.randomUUID();
    expect(subscriptionUpdateSchema.parse({ revision, sources: configs }).sources.filter(source => source.platform === 'wechat')).toHaveLength(10);
    const { platform, ...old } = configs[0]!;
    expect(subscriptionUpdateSchema.parse({ revision, sources: [old] }).sources[0]!.platform).toBe('wechat');
    expect(() => subscriptionUpdateSchema.parse({ revision, sources: [{ ...configs.find(source => source.platform === 'bilibili')!, id: 'YT-123' }] })).toThrow();
    expect(() => subscriptionUpdateSchema.parse({ revision, sources: [configs[0], configs[0]] })).toThrow();
  });
  it('校验 YouTube 频道与每条作者身份，保留发布时间和稳定视频标识', () => {
    const identity = { platform: 'youtube' as const, accountId: channel };
    const entries = parseRss(atom, 'https://www.youtube.com/feeds/videos.xml', false, identity);
    expect(entries[0]).toMatchObject({ identity: 'youtube:12345678901', publishedAt: '2026-10-10T01:00:00.000Z' });
    expect(() => parseRss(atom, 'https://www.youtube.com/feeds/videos.xml', false, { ...identity, accountId: 'UCwrong' })).toThrow();
    expect(() => parseRss(atom.replace('v=12345678901', 'v=another'), 'https://www.youtube.com/feeds/videos.xml', false, identity)).toThrow();
    expect(() => parseRss(atom, 'https://www.youtube.com/feeds/videos.xml', false, { expectedName: '其他账号' })).toThrow();
    const shorts = parseRss(atom.replace('watch?v=12345678901','shorts/12345678901'), 'https://www.youtube.com/feeds/videos.xml', false, identity);
    expect(shorts[0]).toMatchObject({ identity:'youtube:12345678901', url:'https://www.youtube.com/watch?v=12345678901' });
    expect(() => parseRss(atom.replace('watch?v=12345678901','shorts/12345678902'), 'https://www.youtube.com/feeds/videos.xml', false, identity)).toThrow();
  });
  it('B站读取保存官方 JSON，签名有时间戳，并拒绝接口错误、空假成功和作者不符', async () => {
    const calls: URL[] = [];
    const read = async (url: URL) => { calls.push(url); return calls.length === 1 ? nav : JSON.stringify(archives); };
    const feed = await fetchBilibiliFeed('946974', undefined, read, new Date('2026-10-10T01:00:00Z'));
    expect(calls[1]!.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/);
    expect(calls[1]!.searchParams.get('wts')).toBe('1791594000');
    expect(feed.originalJson).toBe(JSON.stringify(archives));
    expect(parseRss(feed.body, feed.url, false, { platform: 'bilibili', accountId: '946974' })[0]!.identity).toBe('bilibili:BV1234567890');
    for (const bad of [{ code: -352 }, { code: 0, data: { list: { vlist: [] } } }, { ...archives, data: { list: { vlist: [{ ...archives.data.list.vlist[0], mid: 1 }] } } }]) {
      await expect(fetchBilibiliFeed('946974', undefined, async url => url.pathname.endsWith('/nav') ? nav : JSON.stringify(bad))).rejects.toThrow();
    }
    await expect(fetchBilibiliFeed('946974', undefined, async url => url.pathname.endsWith('/nav') ? nav : JSON.stringify({ code: 0, data: { page: { count: 0 }, list: { vlist: [] } } }))).resolves.toMatchObject({ status: 200 });
  });
  it('视频只保存链接材料，不调用文章提取；重复检查去重；移除来源后的旧轮询不写入', async () => {
    const texts = new Map<string,string>();
    const files = { read: async (path: string) => texts.get(path) ?? null, write: async (path: string, value: string) => { texts.set(path, value); } } as FileStore;
    const saved: Material[] = []; let articleCalls = 0; let release: (() => void) | undefined; let gate = Promise.resolve(); let body = atom;
    const collector = new SubscriptionCollector({ files, save: async material => { saved.push(material); return true; }, readFeed: async url => { await gate; return { status: 200, body, url }; }, readArticle: async () => { articleCalls++; throw new Error('不能提取视频页面'); } });
    const initial = await collector.list(); const youtube = initial.sources.find(source => source.config.id === 'YT-001')!.config;
    let current = await collector.configure({ collectionScope: 'feed-window', revision: initial.revision, sources: [{ ...youtube, enabled: true, feedUrl: 'https://www.youtube.com/feeds/videos.xml', topic: 'headlines' }] });
    await collector.poll(true); await collector.poll(true);
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ coverage: 'metadata', body: '', guide: '', guideKind: 'none', identity: 'youtube:12345678901' }); expect(articleCalls).toBe(0);
    current = await collector.list();
    await collector.configure({ collectionScope: 'feed-window', revision: current.revision, sources: current.sources.map(source => ({ ...source.config, topic: 'leisure' })) });
    await collector.poll(true); expect(saved).toHaveLength(1); expect(saved[0]!.topic).toBe('headlines');
    body = atom.replaceAll('12345678901', '12345678902');
    gate = new Promise<void>(resolve => { release = resolve; });
    const polling = collector.poll(true);
    await new Promise(resolve => setTimeout(resolve, 10));
    current = await collector.list();
    await collector.configure({ collectionScope: 'feed-window', revision: current.revision, sources: [initial.sources[0]!.config] });
    release!(); await polling; expect(saved).toHaveLength(1); expect((await collector.list()).sources[0]!.config.id).toBe('WX-001');
  });
});
