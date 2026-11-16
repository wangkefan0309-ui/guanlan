import { z } from 'zod';
import { webUrl } from './model';
import { subscriptionConfigSchema, type SubscriptionConfig } from './subscriptions';
import type { SourceCategory } from './categories';

export const resolvedSourceSchema = z.object({ platform: z.enum(['wechat','youtube','bilibili','rss']), name: z.string().trim().min(1).max(160), accountId: z.string().optional(), feedUrl: webUrl }).strict();
export type ResolvedSource = z.infer<typeof resolvedSourceSchema>;
/** Use the RSSHub provider explicitly saved on existing UP subscriptions. */
export function useConfiguredBilibiliFeed(source: ResolvedSource, sources: SubscriptionConfig[]): ResolvedSource {
  if (source.platform !== 'bilibili' || !source.accountId || source.feedUrl !== `https://space.bilibili.com/${source.accountId}`) return source;
  const providers = new Map<string, URL>();
  for (const saved of sources) {
    if (saved.platform !== 'bilibili' || !saved.accountId || !saved.feedUrl) continue;
    const url = new URL(saved.feedUrl);
    if (url.username || url.password || url.search || url.hash || !new RegExp(`^/bilibili/user/video/${saved.accountId}(?:/noembed)?/?$`).test(url.pathname)) continue;
    providers.set(url.origin, url);
  }
  if (providers.size > 1) throw new Error('已配置多个 RSSHub 服务，请先统一 B站来源的更新链接。');
  const provider = providers.values().next().value;
  if (!provider) return source;
  provider.pathname = `/bilibili/user/video/${source.accountId}/noembed`;
  return { ...source, feedUrl: provider.href };
}
export function makeSourceConfig(source: ResolvedSource, category: SourceCategory, name = source.name): SubscriptionConfig {
  return subscriptionConfigSchema.parse({ id: `${{wechat:'WX',youtube:'YT',bilibili:'BL',rss:'RSS'}[source.platform]}-${crypto.randomUUID()}`, platform: source.platform,
    name, accountName: source.name, accountId: source.accountId, categoryId: category.id, topic: category.topic, enabled: true, feedUrl: source.feedUrl, intervalMinutes: 60, summaryIsBody: false });
}
