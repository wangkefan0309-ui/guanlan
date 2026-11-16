import { describe, expect, it } from 'vitest';
import type { FileStore, Material } from '../src/core/model';
import { defaultCategories } from '../src/core/categories';
import { makeSourceConfig } from '../src/core/source-management';
import { SubscriptionCollector } from '../src/server/subscriptions';
import type { FeedResponse } from '../src/server/feed-fetch';

class Files implements FileStore {
  data = new Map<string, string>();
  fail = false;
  async read(path: string) { return this.data.get(path) ?? null; }
  async write(path: string, content: string) { if (this.fail) throw Error('磁盘写入失败'); this.data.set(path, content); }
  async readBinary(path: string) { const value = await this.read(path); return value === null ? null : new TextEncoder().encode(value); }
  async writeBinary(path: string, value: Uint8Array) { await this.write(path, new TextDecoder().decode(value)); }
}
const body = '<p>这是一篇独立博客的正文，记录订阅来源的手动管理。保留原文和发布时间，重新开启订阅后已有文章不应重复保存。</p>';
function feed(url: string, full = true): FeedResponse {
  return { status: 200, url, body: `<rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>独立博客</title><item><title>博客文章</title><link>https://example.org/post</link><pubDate>Sun, 18 Oct 2026 00:00:00 GMT</pubDate>${full ? `<content:encoded><![CDATA[${body}]]></content:encoded>` : '<description>一段摘要</description>'}</item></channel></rss>` };
}
const config = (name = '独立博客') => makeSourceConfig({ platform: 'rss', name, feedUrl: `https://example.org/${encodeURIComponent(name)}.xml` }, defaultCategories()[0]!);
async function configure(collector: SubscriptionCollector, sources: ReturnType<typeof config>[]) {
  return collector.configure({ revision: (await collector.list()).revision, sources });
}
const now = () => new Date('2026-10-18T04:00:00Z');

describe('手动订阅与停止抓取', () => {
  it('普通 RSS 正文字段保留原件；关闭后强制检查也不读取，重启仍关闭，重开不重复收录', async () => {
    const files = new Files(), saved: Material[] = []; let calls = 0;
    const dependencies = { files, now, save: async (material: Material) => { saved.push(material); return true; }, readFeed: async (url: string) => { calls++; return feed(url); } };
    const collector = new SubscriptionCollector(dependencies), source = config();
    await configure(collector, [source]); await collector.poll(true);
    expect(saved).toHaveLength(1); expect(saved[0]).toMatchObject({ sourceId: source.id, publishedAt: '2026-10-18T00:00:00.000Z', original: { extension: 'html' } }); expect(saved[0]!.body).toContain('独立博客的正文');
    await configure(collector, [{ ...source, enabled: false }]); await collector.poll(true);
    const restored = new SubscriptionCollector(dependencies); expect((await restored.list()).sources[0]!.status).toBe('paused'); await restored.poll(true); expect(calls).toBe(1);
    await configure(restored, [source]); await restored.poll(true); expect(calls).toBe(2); expect(saved).toHaveLength(1);
  });
  it('RSS 只有摘要时读取原网页，不套用公众号身份校验或把摘要冒充正文', async () => {
    const saved: Material[] = []; let articleCalls = 0;
    const collector = new SubscriptionCollector({ files: new Files(), now, save: async material => { saved.push(material); return true; }, readFeed: async url => feed(url, false), readArticle: async () => { articleCalls++; return `<html><body><article>${body}</article></body></html>`; } });
    await configure(collector, [config()]); await collector.poll(true);
    expect(articleCalls).toBe(1); expect(saved).toHaveLength(1); expect(saved[0]!.body).toContain('独立博客的正文'); expect(saved[0]!.body).not.toBe('一段摘要');
  });
  it.each(['feed', 'article'] as const)('关闭时中止正在读取的 %s，只停止该来源，后面的来源继续采集', async stage => {
    const files = new Files(), saved: Material[] = [], first = config('第一个'), second = config('第二个'); let active!: AbortSignal; let started!: () => void;
    const began = new Promise<void>(done => { started = done; });
    const blocked = (signal: AbortSignal) => new Promise<string>((_done, reject) => { active = signal; started(); signal.addEventListener('abort', () => reject(Error('取消读取')), { once: true }); });
    const collector = new SubscriptionCollector({ files, now, save: async material => { saved.push(material); return true; },
      readFeed: async (url, request) => { if (stage === 'feed' && url === first.feedUrl) await blocked(request.signal!); return feed(url, stage !== 'article' || url !== first.feedUrl); },
      readArticle: async (_url, signal) => blocked(signal),
    });
    await configure(collector, [first, second]); const task = collector.poll(true); await began;
    await configure(collector, [{ ...first, enabled: false }, second]); expect(active.aborted).toBe(true); await task;
    expect(saved.map(material => material.sourceId)).toEqual([second.id]);
    const view = await collector.list(); expect(view.sources[0]!.status).toBe('paused'); expect(view.sources[1]!.status).toBe('ok');
  });
  it('保存关闭状态失败时继续原订阅，不提前中止；成功后即使读取方忽略中止并迟到也不保存旧结果', async () => {
    const files = new Files(), saved: Material[] = [], source = config(); let release!: () => void; let active!: AbortSignal;
    const collector = new SubscriptionCollector({ files, now, save: async material => { saved.push(material); return true; }, readFeed: async (url, request) => { active = request.signal!; await new Promise<void>(done => { release = done; }); return feed(url); } });
    await configure(collector, [source]); const task = collector.poll(true);
    while (!release) await new Promise(done => setTimeout(done, 1));
    files.fail = true; await expect(configure(collector, [{ ...source, enabled: false }])).rejects.toThrow('磁盘'); expect(active.aborted).toBe(false);
    files.fail = false; await configure(collector, [{ ...source, enabled: false }]); await configure(collector, [source]);
    release(); await task; expect(saved).toHaveLength(0); expect((await collector.list()).sources[0]!.status).toBe('waiting');
  });
});
