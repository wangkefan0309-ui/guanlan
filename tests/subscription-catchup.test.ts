import { describe, expect, it } from 'vitest';
import type { FileStore, Material } from '../src/core/model';
import { SubscriptionCollector } from '../src/server/subscriptions';
import type { FeedRequest } from '../src/server/feed-fetch';

const start = '2026-10-13T04:00:00Z', late = '2026-10-14T15:05:49Z', resumed = '2026-10-19T04:00:00Z';
function files() {
  const data = new Map<string, string>();
  return { data, read: async (p: string) => data.get(p) ?? null, write: async (p: string, v: string) => { data.set(p, v); }, readBinary: async () => null, writeBinary: async () => {} } satisfies FileStore & { data: Map<string, string> };
}
function rss(entries: { id: string; date?: string }[]) {
  return `<rss><channel><title>补收测试</title>${entries.map(e => `<item><title>${e.id}</title><link>https://mp.weixin.qq.com/s/${e.id}</link>${e.date ? `<pubDate>${e.date}</pubDate>` : ''}</item>`).join('')}</channel></rss>`;
}
function page(date: string, body = '<p>核实身份和日期后的原页面正文。</p>') {
  return `<html><script>var biz="MzU0MjYwNDU2Mw==";var ct=${Math.floor(Date.parse(date) / 1000)};</script><body><div id="js_content">${body}</div></body></html>`;
}
async function enable(c: SubscriptionCollector, catchupDays = 7) {
  const view = await c.list();
  return c.configure({ revision: view.revision, catchupDays, sources: [{ ...view.sources[0]!.config, enabled: true, feedUrl: 'https://example.org/feed', topic: 'opinion', categoryId: 'opinion' }] });
}

describe('有界跨天补收', () => {
  it('正文连接断开仅重试一次，保存失败页原件且验证页不确认成功，真实错号仍拦截', async () => {
    const store = files(), saved: Material[] = []; let reads = 0, mode = 'network', now = new Date(start);
    const deps = { files: store, now: () => now, save: async (m: Material) => { saved.push(m); return true; }, readFeed: async () => ({ status: 200 as const, url: 'https://example.org/feed', body: rss([{ id: 'article-read', date: late }]) }), readArticle: async () => {
      reads++;
      if (mode === 'network' && reads === 1) throw Error('socket hang up');
      if (mode === 'challenge') return '<html><body>环境异常，请完成验证后继续访问</body></html>';
      if (mode === 'wrong-account') return page(late).replace('MzU0MjYwNDU2Mw==', 'wrongBiz');
      return page(late);
    } };
    const c = new SubscriptionCollector(deps); await enable(c); now = new Date(resumed); await c.poll(true); expect(reads).toBe(2); expect(saved).toHaveLength(1);
    // A changed upstream entry must be rechecked, without accepting an interstitial as an article.
    const state = JSON.parse(store.data.get('subscriptions.json')!); state.sources[0].seen = {}; store.data.set('subscriptions.json', JSON.stringify(state));
    mode = 'challenge'; const challenge = new SubscriptionCollector(deps); await challenge.poll(true);
    expect((await challenge.list()).sources[0]).toMatchObject({ status: 'error', pending: 1, error: expect.stringContaining('原页面需要验证') });
    expect([...store.data.keys()].some(p => /subscription-snapshots\/.*\.html$/.test(p))).toBe(true);
    mode = 'wrong-account'; await challenge.poll(true);
    expect((await challenge.list()).sources[0]).toMatchObject({ status: 'error', error: expect.stringContaining('原页面账号不匹配') });
    expect(saved).toHaveLength(1);
  });
  it('原先被当天规则跳过的14日文章，19日开启补偿后保存作者原日期，重启不重复', async () => {
    const store = files(), saved: Material[] = []; let now = new Date(start), reads = 0;
    const dependencies = { files: store, now: () => now, save: async (m: Material) => { saved.push(m); return true; }, readFeed: async () => ({ status: 200 as const, url: 'https://example.org/feed', body: rss([{ id: 'missing', date: late }]) }), readArticle: async () => { reads++; return page(late); } };
    const c = new SubscriptionCollector(dependencies); await enable(c, 0); now = new Date(resumed); await c.poll(true);
    expect(saved).toEqual([]); const before = await c.list();
    await c.configure({ revision: before.revision, sources: before.sources.map(s => s.config), catchupDays: 7 }); await c.poll(true);
    expect(saved.map(m => [m.title, m.publishedAt])).toEqual([['missing', '2026-10-14T15:05:49.000Z']]);
    expect((await c.list()).sources[0]).toMatchObject({ status: 'ok', imported: 1, catchupImported: 1, daily: { eligible: 0, older: 1 } });
    await new SubscriptionCollector(dependencies).poll(true); expect(saved).toHaveLength(1); expect(reads).toBe(1);
  });
  it('网络失败与保存失败跨天仍会补收，只确认实际成功的材料', async () => {
    const store = files(), saved: Material[] = []; let now = new Date(start), network = true, disk = true;
    const c = new SubscriptionCollector({ files: store, now: () => now, save: async m => { if (disk) throw Error('模拟保存失败'); saved.push(m); return true; }, readFeed: async () => { if (network) throw Error('模拟网络断开'); return { status: 200, url: 'https://example.org/feed', body: rss([{ id: 'retry', date: late }]), etag: '"one"' }; }, readArticle: async () => page(late) });
    await enable(c); now = new Date(late); await c.poll(true); expect((await c.list()).sources[0]?.status).toBe('error');
    now = new Date(resumed); network = false; await c.poll(true); expect((await c.list()).sources[0]?.pending).toBe(1); expect(saved).toEqual([]);
    disk = false; await c.poll(true); expect(saved).toHaveLength(1); expect((await c.list()).sources[0]?.status).toBe('ok');
  });
  it('七天边界及开始使用日期均生效；未来和无日期不会抓取，RSS日期不能代替作者日期', async () => {
    const saved: Material[] = [], reads: string[] = []; let now = new Date(start);
    const c = new SubscriptionCollector({ files: files(), now: () => now, save: async m => { saved.push(m); return true; }, readFeed: async () => ({ status: 200, url: 'https://example.org/feed', body: rss([{ id: 'before-start', date: '2026-10-12T04:00:00Z' }, { id: 'outside-window', date: '2026-10-11T04:00:00Z' }, { id: 'future', date: '2026-10-20T04:00:00Z' }, { id: 'unknown' }, { id: 'wrong-date', date: resumed }, { id: 'valid', date: late }]) }), readArticle: async url => { reads.push(url); return page(url.endsWith('wrong-date') ? '2026-10-10T04:00:00Z' : late); } });
    await enable(c); now = new Date(resumed); await c.poll(true);
    expect(saved.map(m => m.title)).toEqual(['valid']); expect(reads.map(url => url.split('/').at(-1)).sort()).toEqual(['valid', 'wrong-date']);
  });
  it('补收旧文章也必须有正文，不能以账号日期元数据确认成功', async () => {
    let now = new Date(start), saves = 0;
    const c = new SubscriptionCollector({ files: files(), now: () => now, save: async () => { saves++; return true; }, readFeed: async () => ({ status: 200, url: 'https://example.org/feed', body: rss([{ id: 'empty', date: late }]) }), readArticle: async () => page(late, '') });
    await enable(c); now = new Date(resumed); await c.poll(true); expect(saves).toBe(0); expect((await c.list()).sources[0]).toMatchObject({ status: 'error', pending: 1 });
  });
  it('关闭补偿会取消在途旧策略，不写材料也不覆盖新的等待状态', async () => {
    let now = new Date(start), saves = 0, entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const c = new SubscriptionCollector({ files: files(), now: () => now, save: async () => { saves++; return true; }, readFeed: async () => ({ status: 200, url: 'https://example.org/feed', body: rss([{ id: 'inflight', date: late }]) }), readArticle: async () => { entered(); await gate; return page(late); } });
    await enable(c); now = new Date(resumed); const work = c.poll(true); await ready;
    const view = await c.list(); await c.configure({ revision: view.revision, sources: view.sources.map(s => s.config), catchupDays: 0 }); release(); await work;
    expect(saves).toBe(0); expect((await c.list()).sources[0]?.status).toBe('waiting');
  });
  it('条件缓存仍正常工作，但六小时后强制完整核对，发现缓存未更新的条目', async () => {
    let now = new Date(start); const requests: FeedRequest[] = [], saved: string[] = [];
    const c = new SubscriptionCollector({ files: files(), now: () => now, save: async m => { saved.push(m.title); return true; }, readFeed: async (_url, options) => { requests.push(options); return options.etag ? { status: 304, url: 'https://example.org/feed', body: '' } : { status: 200, url: 'https://example.org/feed', body: rss([{ id: requests.length === 1 ? 'first' : 'later', date: start }]).replace('</item>', '<description>摘要</description></item>'), etag: '"stale"' }; }, readArticle: async () => page(start) });
    let view = await enable(c, 0); await c.configure({ revision: view.revision, sources: view.sources.map(s => s.config), collectionScope: 'feed-window' });
    await c.poll(true); now = new Date(Date.parse(start) + 3600_000); await c.poll(true); now = new Date(Date.parse(start) + 7 * 3600_000); await c.poll(true);
    expect(requests.map(o => o.etag)).toEqual([undefined, '"stale"', undefined]); expect(saved).toEqual(['first', 'later']);
  });
});
