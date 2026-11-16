import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { resolvedSourceSchema, type ResolvedSource } from '../core/source-management';
import { webUrl } from '../core/model';
import { registeredSources } from '../core/source-registry';
import { fetchFeed, type FeedRequest, type FeedResponse } from './feed-fetch';
import { fetchPublicHtml } from './public-fetch';
import { feedName, parseRss } from './rss';
import { fetchYoutubePageFeed } from './youtube';

export interface DiscoveryDependencies {
  readFeed?: (url: string, options: FeedRequest) => Promise<FeedResponse>;
  readPage?: (url: string, signal: AbortSignal) => Promise<string>;
}
const channelId = /^UC[\w-]{22}$/;
export const discoveryInputSchema = z.object({ input: z.string().trim().min(1).max(4096) }).strict();

/** Read channel-owned metadata, never IDs from recommended videos. */
export function youtubeChannelId(html: string): string {
  const { document } = parseHTML(html);
  const ids = new Set<string>();
  for (const node of document.querySelectorAll('link[rel="canonical"],meta[property="og:url"],meta[itemprop="channelId"]')) {
    const value = node.getAttribute('href') ?? node.getAttribute('content') ?? '';
    if (channelId.test(value)) ids.add(value);
    else {
      try {
        const url = new URL(value);
        const id = url.pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/)?.[1];
        if (id && ['www.youtube.com','youtube.com'].includes(url.hostname)) ids.add(id);
      } catch { /* Other metadata is not a channel identity. */ }
    }
  }
  const metadata = html.match(/"channelMetadataRenderer"\s*:\s*\{[^{}]*"externalId"\s*:\s*"(UC[\w-]{22})"/g) ?? [];
  for (const fragment of metadata) ids.add(fragment.match(/"externalId"\s*:\s*"(UC[\w-]{22})"/)![1]!);
  if (ids.size !== 1) throw new Error('无法确认频道身份，请改用 YouTube 的 /channel/UC… 主页地址');
  return [...ids][0]!;
}
export async function resolveSource(input: unknown, dependencies: DiscoveryDependencies = {}): Promise<ResolvedSource> {
  const value = discoveryInputSchema.parse(input).input;
  const url = new URL(webUrl.parse(value));
  if (url.username || url.password) throw new Error('请使用没有用户名和密码的 RSS 或博主主页地址');
  const signal = AbortSignal.timeout(35_000);
  const read = dependencies.readFeed ?? fetchFeed;
  if (['youtube.com','www.youtube.com','m.youtube.com'].includes(url.hostname)) {
    let id: string | undefined;
    if (url.pathname === '/feeds/videos.xml') id = url.searchParams.get('channel_id') ?? undefined;
    else id = url.pathname.match(/^\/channel\/(UC[\w-]{22})(?:\/.*)?$/)?.[1];
    if (!id) {
      if (!/^\/(?:@[^/]+|c\/[^/]+|user\/[^/]+)(?:\/(?:videos|featured|shorts|streams))?\/?$/.test(url.pathname)) throw new Error('请粘贴 YouTube 博主主页，视频单条链接不能作为订阅');
      const page = `https://www.youtube.com${url.pathname.replace(/\/(videos|featured|shorts|streams)\/?$/, '')}`;
      id = youtubeChannelId(await (dependencies.readPage ?? ((address, abort) => fetchPublicHtml(address, 0, abort, true)))(page, signal));
    }
    if (!channelId.test(id)) throw new Error('频道地址缺少有效的频道身份');
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
    let response:FeedResponse;
    try{response=await read(feedUrl,{signal});}catch(error){
      signal.throwIfAborted();
      if(dependencies.readFeed&&!dependencies.readPage)throw error;
      response=await fetchYoutubePageFeed(id,signal,'today',{readPage:dependencies.readPage?(url,abort)=>dependencies.readPage!(url,abort??signal):undefined});
    }
    if (response.status !== 200) throw new Error('频道订阅未返回可读取的更新列表');
    parseRss(response.body, response.url, false, { platform: 'youtube', accountId: id });
    return resolvedSourceSchema.parse({ platform: 'youtube', name: feedName(response.body), accountId: id, feedUrl });
  }
  if (url.hostname === 'space.bilibili.com') {
    const id = url.pathname.match(/^\/(\d{1,20})(?:\/.*)?$/)?.[1];
    if (!id) throw new Error('请粘贴 B站 UP 主页地址，例如 space.bilibili.com/946974');
    const known = registeredSources.find(source => source.platform === 'bilibili' && source.accountId === id);
    // A homepage identifies an UP even if the anonymous archive API is currently blocked.
    return resolvedSourceSchema.parse({ platform: 'bilibili', name: known?.display_name ?? `B站 UP ${id}`, accountId: id, feedUrl: `https://space.bilibili.com/${id}` });
  }
  const response = await read(url.toString(), { signal });
  if (response.status !== 200) throw new Error('RSS 未返回可读取的更新列表');
  const entries = parseRss(response.body, response.url, false, { platform: 'rss' });
  const platform = entries.length && entries.every(entry => new URL(entry.url).hostname === 'mp.weixin.qq.com') ? 'wechat' : 'rss';
  return resolvedSourceSchema.parse({ platform, name: feedName(response.body), feedUrl: url.toString() });
}
