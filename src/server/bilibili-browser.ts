import { chromium, type Browser } from 'playwright-core';
import { bilibiliFeedFromJson } from './bilibili';
import type { FeedResponse } from './feed-fetch';

/** Reuse a successful five-minute window when the collector drains its 30-item
 * batch or a source is checked again. Failures are never cached as successes. */
export function createBilibiliBrowserReader(executablePath: string, read = fetchBilibiliBrowserFeed, now = () => Date.now()) {
  const cache = new Map<string, { at: number; feed: FeedResponse }>();
  return async (uid: string, signal?: AbortSignal): Promise<FeedResponse> => {
    signal?.throwIfAborted();
    const previous = cache.get(uid);
    if (previous && now() - previous.at >= 0 && now() - previous.at < 300_000) return previous.feed;
    const feed = await read(uid, executablePath, signal);
    signal?.throwIfAborted();
    cache.set(uid, { at: now(), feed });
    if (cache.size > 100) cache.delete(cache.keys().next().value!);
    return feed;
  };
}

/** Ordinary public-page navigation, in a fresh guest context. No personal profile,
 * cookies, login, video downloads, API signing or certificate overrides. */
export async function fetchBilibiliBrowserFeed(uid: string, executablePath: string, signal?: AbortSignal): Promise<FeedResponse> {
  if (!/^\d{1,20}$/.test(uid)) throw new Error('B站 UID 无效');
  signal?.throwIfAborted();
  let browser: Browser | undefined;
  const close = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    // Keep this alternative independent of RSSHub's existing proxy connection.
    browser = await chromium.launch({ executablePath, headless: true, timeout: 15_000, args: ['--no-proxy-server'] });
    signal?.throwIfAborted();
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const allowed = url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        ['bilibili.com', 'hdslb.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
      return allowed && request.resourceType() !== 'media' ? route.continue() : route.abort();
    });
    const waited = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === 'https://api.bilibili.com' && url.pathname === '/x/space/wbi/arc/search' &&
        url.searchParams.get('mid') === uid && response.request().method() === 'GET';
    }, { timeout: 45_000 }).then(response => ({ response }), () => ({ response: null }));
    try { await page.goto(`https://space.bilibili.com/${uid}/video`, { waitUntil: 'domcontentloaded', timeout: 30_000 }); }
    catch { signal?.throwIfAborted(); /* An unfinished page may already have returned its list. */ }
    const { response } = await waited;
    signal?.throwIfAborted();
    if (!response) throw new Error('B站公开投稿页未在45秒内返回列表');
    if (response.status() !== 200 || !response.headers()['content-type']?.includes('application/json')) {
      throw new Error(`B站公开投稿页返回 HTTP ${response.status()}，下次按退避间隔重试`);
    }
    const raw = await response.text();
    signal?.throwIfAborted();
    return { ...bilibiliFeedFromJson(uid, raw), collectionMethod: 'browser' };
  } finally {
    signal?.removeEventListener('abort', close);
    await browser?.close().catch(() => {});
  }
}
