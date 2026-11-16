import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FileStore, Material } from '../src/core/model';
import { collectionStatusUrl, type SubscriptionConfig } from '../src/core/subscriptions';
import { ReadingLibrary } from '../src/core/library';
import registry from '../sources/公众号来源登记.json';
import { SubscriptionCollector } from '../src/server/subscriptions';
import { parseRss } from '../src/server/rss';
import { fetchFeed, type FeedRequest, type FeedResponse } from '../src/server/feed-fetch';
import { createSourceServer } from '../src/server/service';

const articleUrl = 'https://mp.weixin.qq.com/s/validation-article';
function rss(body = '<p>只用于订阅链路验证的正文。</p>', options: { count?: number; summary?: boolean } = {}) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试订阅</title>${Array.from({ length: options.count ?? 1 }, (_, index) => `<item><title>验证文章 ${index + 1}</title><link>${articleUrl}-${index}</link><pubDate>Sat, 10 Oct 2026 00:00:00 GMT</pubDate><${options.summary ? 'description' : 'content:encoded'}><![CDATA[${body}]]></${options.summary ? 'description' : 'content:encoded'}></item>`).join('')}</channel></rss>`;
}
const response = (body = rss(), etag = '"version-1"'): FeedResponse => ({ status: 200, body, url: 'https://example.org/feed.xml', etag });
class Files implements FileStore {
  texts = new Map<string, string>(); failSeenOnce = false;
  async read(path: string) { return this.texts.get(path) ?? null; }
  async write(path: string, content: string) {
    if (this.failSeenOnce && path === 'subscriptions.json' && Object.keys(JSON.parse(content).sources[0].seen).length) { this.failSeenOnce = false; throw new Error('模拟回执写入失败'); }
    this.texts.set(path, content);
  }
  async readBinary(path: string) { const content = await this.read(path); return content === null ? null : new TextEncoder().encode(content); }
  async writeBinary(path: string, content: Uint8Array) { await this.write(path, new TextDecoder().decode(content)); }
}
async function enable(collector: SubscriptionCollector, change: Partial<SubscriptionConfig> = {}) {
  const view = await collector.list();
  await collector.configure({ collectionScope: 'feed-window', revision: view.revision, sources: view.sources.map((source, index) => index === 0 ? { ...source.config, feedUrl: response().url, topic: 'law', enabled: true, ...change } : source.config) });
}
const resources: { server: Server; directory?: string }[] = [];
async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('缺少测试端口');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  if ('collector' in server) await (server as ReturnType<typeof createSourceServer>).collector.stop();
  if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
afterEach(async () => {
  const current = resources.splice(0);
  for (const resource of current) await close(resource.server);
  for (const resource of current) {
    if (resource.directory) {
      const target = resolve(resource.directory);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('source-subscription-')) throw new Error('测试清理路径不在专用临时目录');
      await rm(target, { recursive: true, force: true });
    }
  }
});

describe('AIHOT RSS 采集适配', () => {
  it('采集状态入口仅识别同源、完整绑定的本机管理 feed', () => {
    const configs = [...registry.sources, ...registry.retired_sources].filter(source => /^WX-00[1-5]$/.test(source.registry_id)).sort((a,b) => a.registry_id.localeCompare(b.registry_id)).map(source => ({ id: source.registry_id, enabled: true, feedUrl: `http://127.0.0.1:8001/_workbench/feed/${source.registry_id}`, topic: 'headlines', intervalMinutes: 60, summaryIsBody: false })) as SubscriptionConfig[];
    expect(collectionStatusUrl(configs)).toBe('http://127.0.0.1:8001/_workbench/status');
    for (const invalid of ['http://127.1:8001/_workbench/feed/WX-001', 'http://localhost:8001/_workbench/feed/WX-001', 'http://192.168.1.1:8001/_workbench/feed/WX-001', 'http://127.0.0.1:8002/_workbench/feed/WX-001', 'http://127.0.0.1:8001/custom', configs[0]!.feedUrl + '?token=private', configs[0]!.feedUrl + '#private']) expect(collectionStatusUrl(configs.map((source, index) => index ? source : { ...source, feedUrl: invalid }))).toBeUndefined();
    expect(collectionStatusUrl(configs.slice(1))).toBeUndefined();
    expect(collectionStatusUrl(Array(5).fill(configs[0]))).toBeUndefined();
  });
  it('区分正文和摘要，保留解码后的正文原字段，Atom 优先选 alternate 并遵循 xml:base', () => {
    const entry = parseRss(rss('<p>法律 &amp; 金融</p>'), response().url)[0]!;
    expect(entry.bodyHtml).toBe('<p>法律 &amp; 金融</p>'); expect(entry.publishedAt).toBe('2026-10-10T00:00:00.000Z');
    expect(parseRss(rss('只是一段摘要', { summary: true }), response().url)[0]!.bodyHtml).toBe('');
    expect(parseRss(rss('显式声明摘要就是正文', { summary: true }), response().url, true)[0]!.bodyHtml).toContain('正文');
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://mp.weixin.qq.com/"><entry xml:base="s/"><title>&lt;法律&gt;的基础</title><link rel="self" href="https://example.org/self"/><link rel="alternate" href="validation-atom"/><content type="text">保留 &lt;条文&gt; 字面值</content></entry></feed>';
    const parsed = parseRss(atom, response().url)[0]!; expect(parsed.url).toBe('https://mp.weixin.qq.com/s/validation-atom'); expect(parsed.title).toBe('<法律>的基础'); expect(parsed.bodyHtml).toContain('&lt;条文&gt;');
  });
  it('无效 XML、实体声明、错误原文链接或条目不能提交成空订阅成功', () => {
    for (const invalid of [rss().slice(0, -12), '<!DOCTYPE rss><rss><channel/></rss>', '<html><body>请登录</body></html>', rss().replace(articleUrl, 'http://127.0.0.1/internal'), rss().replace(/<title>验证文章 1<\/title>/, ''), rss('', { count: 201 })]) expect(() => parseRss(invalid, response().url)).toThrow();
  });
  it('支持 WeRSS 的转义 CDATA 字段和 Atom XHTML 混排，外部 content src 不冒充正文', () => {
    const escaped = rss().replace('<![CDATA[<p>只用于订阅链路验证的正文。</p>]]>', '&lt;![CDATA[&lt;p&gt;原字段&lt;/p&gt;]]&gt;');
    expect(parseRss(escaped, response().url)[0]!.bodyHtml).toBe('<p>原字段</p>');
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">题<b>目</b></div></title><link href="https://mp.weixin.qq.com/s/x"/><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">先<b>重点</b>后</div></content></entry></feed>';
    const parsed = parseRss(atom, response().url)[0]!; expect(parsed.title).toBe('题目'); expect(parsed.bodyHtml).toContain('先<b>重点</b>后');
    expect(parseRss(atom.replace(/<content.*?<\/content>/, '<content src="https://example.org/body"/>'), response().url)[0]!.bodyHtml).toBe('');
  });
});

describe('订阅的持久化回执与恢复', () => {
  it('单次TLS断开会有界重试同一feed，限流或授权失败不重试', async () => {
    for (const [error, attempts] of [['Client network socket disconnected before secure TLS connection was established', 2], ['订阅返回 HTTP 429', 1], ['采集端授权需重新确认', 1]] as const) {
      let calls = 0; const saved: Material[] = [];
      const collector = new SubscriptionCollector({ files: new Files(), readFeed: async () => { if (++calls === 1) throw Error(error); return response(); }, save: async m => { saved.push(m); return true; } });
      await enable(collector); await collector.poll(true);
      expect(calls, error).toBe(attempts); expect(saved).toHaveLength(attempts === 2 ? 1 : 0);
    }
  });
  it('连续网络故障最多退避一小时，恢复后自动收录，不必等到次日手动检查', async () => {
    const files = new Files(); let time = new Date('2026-10-29T01:00:00Z'), offline = true, calls = 0;
    const saved: Material[] = [];
    const dependencies = { files, now: () => time, readFeed: async () => { calls++; if (offline) throw Error('Client network socket disconnected before secure TLS connection was established'); return response(); }, save: async (material: Material) => { saved.push(material); return true; } };
    const collector = new SubscriptionCollector(dependencies); await enable(collector);
    for (let i = 0; i < 10; i++) await collector.poll(true);
    expect(Date.parse((await collector.list()).sources[0]!.nextDue!) - time.getTime()).toBeLessThanOrEqual(3600_000);
    offline = false; time = new Date(time.getTime() + 3600_000);
    await new SubscriptionCollector(dependencies).poll();
    expect(calls).toBe(21); expect(saved).toHaveLength(1);
  });
  it('重启修正旧网络错误的跨日等待，保留授权错误的长退避', async () => {
    for (const [error, recover] of [['订阅读取超时', true], ['Client network socket disconnected before secure TLS connection was established', true], ['订阅返回 HTTP 429', false], ['采集端授权需重新确认', false]] as const) {
      const files = new Files(); let calls = 0;
      const dependencies = { files, now: () => new Date('2026-10-30T02:00:00Z'), readFeed: async () => { calls++; return response(); }, save: async () => true };
      await enable(new SubscriptionCollector(dependencies));
      const state = JSON.parse(files.texts.get('subscriptions.json')!);
      Object.assign(state.sources[0], { phase: 'error', error, failures: 21, lastAttempt: '2026-10-30T00:00:00Z', nextDue: '2026-10-31T00:00:00Z' });
      files.texts.set('subscriptions.json', JSON.stringify(state));
      await new SubscriptionCollector(dependencies).poll();
      expect(calls, error).toBe(recover ? 1 : 0);
    }
  });
  it('早上网络失败后一分钟重试，重启保留期限，恢复成功后回到一小时检查且不重复保存', async () => {
    const files = new Files(); let time = new Date('2026-10-11T00:00:00Z'), offline = true, calls = 0;
    const saved = new Map<string, Material>();
    const dependencies = { files, now: () => time, readFeed: async () => { calls++; if (offline) throw new Error('网络尚未就绪'); return response(); }, save: async (material: Material) => { if (saved.has(material.identity)) return false; saved.set(material.identity, material); return true; } };
    const first = new SubscriptionCollector(dependencies); await enable(first); await first.poll(); await first.stop();
    expect((await first.list()).sources[0]!.lastSuccess).toBeNull();
    const restarted = new SubscriptionCollector(dependencies);
    time = new Date('2026-10-11T00:00:30Z'); offline = false; await restarted.poll(); expect(calls).toBe(2);
    time = new Date('2026-10-11T00:01:00Z'); await restarted.poll(); expect(calls).toBe(3); expect(saved.size).toBe(1);
    expect((await restarted.list()).sources[0]).toMatchObject({ status: 'ok', nextDue: '2026-10-11T01:01:00.000Z' });
    time = new Date('2026-10-11T01:01:00Z'); await restarted.poll(); expect(saved.size).toBe(1); await restarted.stop();
  });
  it('未配置时不出网，配置拒绝无板块/重复账号/过期修改，检查间隔生效', async () => {
    let calls = 0; let now = new Date('2026-10-10T00:00:00Z');
    const collector = new SubscriptionCollector({ files: new Files(), save: async () => true, readFeed: async () => { calls++; return response(); }, now: () => now });
    await collector.poll(); expect(calls).toBe(0);
    const first = await collector.list();
    await expect(enable(collector, { topic: null })).rejects.toThrow();
    await expect(collector.configure({ revision: first.revision, sources: Array(5).fill(first.sources[0]!.config) })).rejects.toThrow();
    await enable(collector); await expect(collector.configure({ revision: first.revision, sources: first.sources.map(source => source.config) })).rejects.toThrow('其他窗口');
    await collector.poll(); await collector.poll(); expect(calls).toBe(1);
    now = new Date('2026-10-10T01:01:00Z'); await collector.poll(); expect(calls).toBe(2);
  });
  it('重复抓取和重启只保存一次，正文原字段与订阅 XML 原件分开保留，304 使用持久化检查记录', async () => {
    const files = new Files(); const saved: Material[] = []; const requests: FeedRequest[] = [];
    const read = async (_url: string, request: FeedRequest) => { requests.push(request); return request.etag ? { ...response(''), status: 304 as const } : response(); };
    const dependencies = { files, save: async (material: Material) => { saved.push(material); return true; }, readFeed: read };
    const collector = new SubscriptionCollector(dependencies); await enable(collector);
    const task = collector.poll(); expect(collector.poll(true)).toBe(task); await task;
    await new SubscriptionCollector(dependencies).poll(true);
    expect(saved).toHaveLength(1); expect(requests[1]!.etag).toBe('"version-1"'); expect(saved[0]!.source).toBe('记忆承载'); expect(saved[0]!.coverage).toBe('partial');
    expect(Buffer.from(saved[0]!.original!.base64, 'base64').toString()).toBe('<p>只用于订阅链路验证的正文。</p>');
    expect([...files.texts.entries()].find(([key]) => key.endsWith('.xml'))![1]).toBe(rss());
  });
  it('一项保存失败仍接收独立材料，不提交 ETag；重启只重试失败项', async () => {
    const files = new Files(); let failed = true; const attempts: string[] = []; const requests: FeedRequest[] = [];
    const dependencies = { files, readFeed: async (_url: string, request: FeedRequest) => { requests.push(request); return response(rss(undefined, { count: 2 })); }, save: async (material: Material) => { attempts.push(material.url!); if (material.url!.endsWith('-0') && failed) throw new Error('磁盘写入失败'); return true; } };
    const collector = new SubscriptionCollector(dependencies); await enable(collector); await collector.poll();
    expect((await collector.list()).sources[0]).toMatchObject({ status: 'error', imported: 1, pending: 1, lastSuccess: null });
    failed = false; const restart = new SubscriptionCollector(dependencies); await restart.poll(true);
    expect(attempts.filter(url => url.endsWith('-1'))).toHaveLength(1); expect(attempts.filter(url => url.endsWith('-0'))).toHaveLength(2); expect(requests[1]!.etag).toBeUndefined(); expect((await restart.list()).sources[0]!.status).toBe('ok');
  });
  it('正文已保存但回执失败时仍可重试，未提前确认成功', async () => {
    const files = new Files(); let attempts = 0;
    const dependencies = { files, readFeed: async () => response(), save: async () => { attempts++; return attempts === 1; } };
    const collector = new SubscriptionCollector(dependencies); await enable(collector); files.failSeenOnce = true; await collector.poll();
    expect((await collector.list()).sources[0]!.status).toBe('error'); await new SubscriptionCollector(dependencies).poll(true); expect(attempts).toBe(2);
  });
  it('采集中暂停或改变来源时保留新配置，不向新配置提交旧请求结果', async () => {
    let release!: () => void; let reached!: () => void; const ready = new Promise<void>(done => { reached = done; }); const gate = new Promise<void>(done => { release = done; }); let saves = 0;
    const collector = new SubscriptionCollector({ files: new Files(), save: async () => { saves++; return true; }, readFeed: async () => { reached(); await gate; return response(); } });
    await enable(collector); const task = collector.poll(); await ready;
    const state = await collector.list(); await collector.configure({ revision: state.revision, sources: state.sources.map(source => ({ ...source.config, enabled: false })) });
    release(); await task; expect(saves).toBe(0); expect((await collector.list()).sources[0]!.status).toBe('paused');
  });
  it('摘要要核对原页面账号，验证页不保存假正文，修复后恢复', async () => {
    const saved: Material[] = []; let valid = false;
    const collector = new SubscriptionCollector({ files: new Files(), save: async material => { saved.push(material); return true; }, readFeed: async () => response(rss('只是摘要', { summary: true })), readArticle: async () => valid ? '<html><script>var biz="MzU0MjYwNDU2Mw==";</script><body><a id="js_name">记忆承载</a><div id="js_content"><p>从原页面提取的验证正文。</p></div></body></html>' : '<html><body>登录验证</body></html>' });
    await enable(collector); await collector.poll(); expect(saved).toHaveLength(0); expect((await collector.list()).sources[0]!.status).toBe('error');
    valid = true; await collector.poll(true); expect(saved[0]!.body).toContain('从原页面提取'); expect((await collector.list()).sources[0]!.lastSuccess).not.toBeNull();
  });
  it('初次积压分批保存，处理完整页之前不提交条件请求，配置变更清除校验器', async () => {
    let saves = 0; const requests: FeedRequest[] = [];
    const collector = new SubscriptionCollector({ files: new Files(), save: async () => { saves++; return true; }, readFeed: async (_url, request) => { requests.push(request); return response(rss(undefined, { count: 35 })); } });
    await enable(collector); await collector.poll(); expect(saves).toBe(30); expect((await collector.list()).sources[0]!.pending).toBe(5);
    await collector.poll(true); expect(saves).toBe(35); expect(requests[1]!.etag).toBeUndefined();
    await enable(collector, { intervalMinutes: 30 }); await collector.poll(true); expect(saves).toBe(35); expect(requests[2]!.etag).toBeUndefined();
  });
  it('无校验器或重定向目标改变的 304 重新取正文，中断检查可在重启后恢复', async () => {
    let calls = 0; const files = new Files(); let reject!: (error: Error) => void;
    const collector = new SubscriptionCollector({ files, save: async () => true, readFeed: async () => ++calls === 1 ? { ...response(''), status: 304 } : response() });
    await enable(collector); await collector.poll(); expect(calls).toBe(2);
    const interrupted = new SubscriptionCollector({ files, save: async () => true, readFeed: async (_url, request) => new Promise((_done, failed) => { reject = failed; request.signal!.addEventListener('abort', () => reject(new Error('已中断'))); }) });
    const task = interrupted.poll(true); while (!reject) await new Promise(done => setTimeout(done, 1)); await interrupted.stop(); await task;
    const restored = new SubscriptionCollector({ files, save: async () => true, readFeed: async () => response() }); await restored.poll(); expect((await restored.list()).sources[0]!.status).toBe('ok');
  });
  it('材料账本重建后重新发现材料，不能沿用旧回执跳过实际已丢失的保存结果', async () => {
    const files = new Files(); let instance = 'ledger-before'; let saves = 0;
    const dependencies = { files, ledgerInstance: async () => instance, save: async () => { saves++; return true; }, readFeed: async (_url: string, request: FeedRequest) => { expect(request.etag).toBeUndefined(); return response(); } };
    const collector = new SubscriptionCollector(dependencies); await enable(collector); await collector.poll();
    instance = 'ledger-after'; await new SubscriptionCollector(dependencies).poll(); expect(saves).toBe(2);
  });
  it('重定向目标的 304 要无条件重取，重复的无条件 304 必须报告失败', async () => {
    const files = new Files(); const first = new SubscriptionCollector({ files, save: async () => true, readFeed: async () => response() });
    await enable(first); await first.poll(); let calls = 0;
    const moved = new SubscriptionCollector({ files, save: async () => true, readFeed: async (_url, request) => {
      calls++; if (calls === 2) expect(request.etag).toBeUndefined(); return { ...response(''), status: 304, url: 'https://example.org/changed.xml' };
    } });
    await moved.poll(true); expect(calls).toBe(2); expect((await moved.list()).sources[0]).toMatchObject({ status: 'error', error: expect.stringContaining('无条件请求') });
  });
});

describe('订阅 HTTP 与真实本机 XML 传输', () => {
  it('纯文字短帖从原 HTML 提取到 feed 和阅读库，身份错误不保存，重启同步去重', async () => {
    // Synthetic short-post fixture for collection, identity, and sync checks.
    const source = registry.sources.find(source => source.registry_id === 'WX-003')!;
    const body = '这是用于离线测试的公开短帖预览。';
    const html = `<html><body><div id="js_content"></div><script>var info={nick_name:'dontbesilent',content_noencode:'${body}'};var biz = '' || '${source.biz}';var ct = '1791536341';</script></body></html>`;
    const xml = `<rss><channel><item><title>未命名公众号内容</title><link>https://mp.weixin.qq.com/s/guanlan-sample</link><description>仅是目录摘要</description></item></channel></rss>`;
    let mismatch = true;
    const directory = await mkdtemp(join(tmpdir(), 'source-subscription-short-'));
    const token = 'short-post-test-token-12345';
    const server = createSourceServer({ directory, token, subscriptionDependencies: {
      readFeed: async () => response(xml), readArticle: async () => mismatch ? html.replaceAll(source.biz!, 'another-account') : html,
    } });
    resources.push({ server, directory }); const url = await listen(server);
    await server.collector.poll(); const view = await server.collector.list();
    await server.collector.configure({ collectionScope: 'feed-window', revision: view.revision, sources: view.sources.map(item => item.config.id === source.registry_id ? { ...item.config, feedUrl: response().url, topic: 'headlines', enabled: true } : item.config) });
    await server.collector.poll(true);
    const feed = () => fetch(`${url}/v1/feed`, { headers: { Authorization: `Bearer ${token}` } }).then(result => result.json());
    expect((await feed()).items).toHaveLength(0);
    expect((await server.collector.list()).sources[2]!.error).toContain('不匹配');
    mismatch = false; await server.collector.poll(true);
    const saved = await feed(); expect(saved.items).toHaveLength(1);
    const material = saved.items[0];
    expect(material.source).toBe('dontbesilent');
    expect(material.body).toBe(body); expect(material.coverage).toBe('partial');
    expect(Buffer.from(material.original.base64, 'base64').toString()).toBe(html);
    const files = new Files(); const library = new ReadingLibrary(files, '09_信息源');
    await library.sync(saved); const item = (await library.list())[0]!;
    await library.updateProgress(item.id, item.version, 'reading', '短帖预览');
    await server.collector.poll(true);
    const restored = new ReadingLibrary(files, '09_信息源'); await restored.sync(await feed());
    expect(await restored.list()).toHaveLength(1);
    expect((await restored.list())[0]).toMatchObject({ progress: 'reading', position: '短帖预览' });
    expect(await files.read(item.path)).toContain(body);
  });
  it('本机采集端的限流回执保留错误原因，不确认空页或虚构材料', async () => {
    const upstream = createServer((_req, res) => { res.writeHead(503, { 'X-Source-Error': '200013' }); res.end(); });
    const url = await listen(upstream); const files = new Files(); let saves = 0;
    try {
      const collector = new SubscriptionCollector({ files, save: async () => { saves++; return true; } });
      await enable(collector, { feedUrl: `${url}/feed` }); await collector.poll(true);
      expect(saves).toBe(0); expect((await collector.list()).sources[0]).toMatchObject({ status: 'error', lastSuccess: null, error: expect.stringContaining('200013') });
    } finally { await close(upstream); }
  });
  it('固定账号配置与采集回执需要鉴权；原件经 feed 同步，重启与正文更新去重', async () => {
    let body = rss(); const upstream = createServer((_request, outgoing) => { outgoing.writeHead(200, { 'Content-Type': 'application/rss+xml', ETag: '"test"' }); outgoing.end(body); }); resources.push({ server: upstream }); const upstreamUrl = await listen(upstream);
    const directory = await mkdtemp(join(tmpdir(), 'source-subscription-')); const token = 'subscription-test-token-12345';
    const server = createSourceServer({ directory, token }); resources.push({ server, directory }); const url = await listen(server); await server.collector.poll();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${url}/v1/subscriptions`)).status).toBe(401); expect((await fetch(`${url}/v1/subscriptions/poll`, { method: 'POST', body: '{}' })).status).toBe(401);
    let view = await fetch(`${url}/v1/subscriptions`, { headers }).then(result => result.json());
    const update = { collectionScope:'feed-window', revision: view.revision, sources: view.sources.map((source: any, index: number) => index ? source.config : { ...source.config, feedUrl: `${upstreamUrl}/feed.xml`, enabled: true, topic: 'law' }) };
    expect((await fetch(`${url}/v1/subscriptions`, { method: 'POST', headers, body: JSON.stringify(update) })).status).toBe(200);
    expect((await fetch(`${url}/v1/subscriptions/poll`, { method: 'POST', headers, body: '{}' })).status).toBe(200); await server.collector.poll();
    const feed = await fetch(`${url}/v1/feed`, { headers }).then(result => result.json()); expect(feed.cursor).toBe(1); expect(feed.items[0].body).toContain('订阅链路验证');
    view = await fetch(`${url}/v1/subscriptions`, { headers }).then(result => result.json()); expect(view.sources[0].status).toBe('ok');
    expect(JSON.parse(await readFile(join(directory, 'subscriptions.json'), 'utf8')).sources[0].seen).not.toEqual({});
    await close(server);
    const restarted = createSourceServer({ directory, token }); resources.push({ server: restarted }); const nextUrl = await listen(restarted); await restarted.collector.poll(true);
    expect((await fetch(`${nextUrl}/v1/feed`, { headers }).then(result => result.json())).cursor).toBe(1);
    body = rss('<p>更新后的验证正文。</p>'); await restarted.collector.poll(true);
    const updated = await fetch(`${nextUrl}/v1/feed`, { headers }).then(result => result.json()); expect(updated.cursor).toBe(2); expect(updated.items[1].identity).toBe(updated.items[0].identity);
    expect((await fetch(`${nextUrl}/v1/import`, { method: 'POST', headers, body: JSON.stringify({ format: 'url', url: `${upstreamUrl}/feed.xml` }) })).status).toBe(400);
  });
  it('拒绝内网、跨地址重定向和登录 HTML，不通过订阅通道扩大网页导入权限', async () => {
    await expect(fetchFeed('http://192.168.1.1/feed')).rejects.toThrow('公网');
    const upstream = createServer((incoming, outgoing) => {
      if (incoming.url === '/redirect') { outgoing.writeHead(302, { Location: 'http://127.0.0.1:1/internal' }); outgoing.end(); }
      else { outgoing.writeHead(200, { 'Content-Type': 'text/html' }); outgoing.end('<html>请登录</html>'); }
    }); resources.push({ server: upstream }); const url = await listen(upstream);
    await expect(fetchFeed(`${url}/redirect`)).rejects.toThrow('同一地址'); await expect(fetchFeed(`${url}/login`)).rejects.toThrow('授权状态');
  });
});
