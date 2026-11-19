import { z } from 'zod';
import { categoryIdSchema, topics, webUrl } from './model';
import { categoriesSchema, defaultCategories } from './categories';
import { subscriptionCheckSchema } from './subscription-health';

export const collectionScopeSchema = z.enum(['today', 'feed-window']);
export const catchupDaysSchema = z.number().int().min(0).max(7);
export type CollectionScope = z.infer<typeof collectionScopeSchema>;
export const dailyCollectionSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), eligible: z.number().int().nonnegative(), older: z.number().int().nonnegative(), undated: z.number().int().nonnegative(), future: z.number().int().nonnegative() }).strict();

export const subscriptionConfigSchema = z.object({
  id: z.string().regex(/^(WX|YT|BL|RSS)-(\d{3}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/),
  platform: z.enum(['wechat', 'youtube', 'bilibili', 'rss']).default('wechat'),
  name: z.string().trim().min(1).max(160).optional(),
  accountName: z.string().trim().min(1).max(160).optional(),
  accountId: z.string().max(120).optional(),
  categoryId: categoryIdSchema.optional(),
  enabled: z.boolean(),
  feedUrl: z.union([z.literal(''), webUrl]),
  topic: z.enum(topics).nullable(),
  intervalMinutes: z.number().int().min(15).max(1440),
  summaryIsBody: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  if (value.enabled && (!value.feedUrl || !value.topic)) context.addIssue({ code: 'custom', message: '开启订阅需要填写更新链接并选择学习板块' });
  const prefix = { wechat: 'WX-', youtube: 'YT-', bilibili: 'BL-', rss: 'RSS-' }[value.platform];
  if (!value.id.startsWith(prefix)) context.addIssue({ code: 'custom', message: '来源标识与平台不匹配' });
  if (value.platform === 'youtube' && !/^UC[\w-]{22}$/.test(value.accountId ?? '')) context.addIssue({ code: 'custom', message: 'YouTube 需要稳定频道 ID' });
  if (value.platform === 'bilibili' && !/^\d{1,20}$/.test(value.accountId ?? '')) context.addIssue({ code: 'custom', message: 'B站需要 UP 主 UID' });
});
export type SubscriptionConfig = z.infer<typeof subscriptionConfigSchema>;
export const subscriptionUpdateSchema = z.object({
  revision: z.uuid(),
  sources: z.array(subscriptionConfigSchema).min(1).max(100),
  categories: categoriesSchema.optional(),
  collectionScope: collectionScopeSchema.optional(),
  catchupDays: catchupDaysSchema.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.sources.map(source => source.id)).size !== value.sources.length) context.addIssue({ code: 'custom', message: '来源配置标识必须各不相同' });
  const keys = value.sources.map(source => ['wechat', 'rss'].includes(source.platform) ? source.feedUrl ? `feed:${new URL(source.feedUrl).href}` : '' : `${source.platform}:${source.accountId}`).filter(Boolean);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: 'custom', message: '这个来源已经订阅，请修改已有来源' });
  if (value.categories && value.sources.some(source => source.categoryId && !value.categories!.some(category => category.id === source.categoryId && category.topic === source.topic))) context.addIssue({ code: 'custom', message: '来源分类不存在；使用中的分类请先移动来源再删除' });
});
export const subscriptionsViewSchema = z.object({
  revision: z.uuid(),
  running: z.boolean(),
  collectionScope: collectionScopeSchema.optional(),
  collectionStartedAt: z.iso.datetime().optional(),
  catchupDays: catchupDaysSchema.optional(),
  categories: categoriesSchema.default(defaultCategories),
  sources: z.array(z.object({
    config: subscriptionConfigSchema,
    name: z.string(),
    status: z.enum(['not-configured', 'paused', 'waiting', 'running', 'ok', 'error']),
    lastAttempt: z.string().nullable(),
    lastSuccess: z.string().nullable(),
    nextDue: z.string().nullable(),
    error: z.string(),
    recentChecks: z.array(subscriptionCheckSchema).max(12).optional(),
    lastFailure: subscriptionCheckSchema.optional(),
    imported: z.number().int().nonnegative(),
    catchupImported: z.number().int().nonnegative().optional(),
    pending: z.number().int().nonnegative(),
    collectionMethod: z.enum(['feed', 'direct-api', 'browser', 'public-page']).optional(),
    daily: dailyCollectionSchema.optional(),
    publicationDates: z.record(webUrl, z.iso.datetime().nullable()).optional(),
  })).min(1).max(100),
}).strict();
export type SubscriptionsView = z.infer<typeof subscriptionsViewSchema>;

/** Only the managed, literal loopback feeds have our read-only status page. */
export function collectionStatusUrl(sources: SubscriptionConfig[]): string | undefined {
  if (sources.length !== 5 || new Set(sources.map(source => source.id)).size !== 5) return;
  let origin: string | undefined;
  for (const source of sources) {
    if (!/^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(source.feedUrl)) return;
    let url: URL; try { url = new URL(source.feedUrl); } catch { return; }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== `/_workbench/feed/${source.id}`) return;
    if (origin && origin !== url.origin) return;
    origin = url.origin;
  }
  return `${origin}/_workbench/status`;
}
