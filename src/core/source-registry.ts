import wechat from '../../sources/公众号来源登记.json';
import videos from '../../sources/视频来源登记.json';
import type { SubscriptionConfig } from './subscriptions';

export interface RegisteredSource {
  registry_id: string;
  platform: SubscriptionConfig['platform'];
  display_name: string;
  verification_status: string;
  accountId?: string;
  biz?: string;
}
export const registeredSources: RegisteredSource[] = [
  ...wechat.sources.map(source => ({ ...source, platform: 'wechat' as const })),
  ...videos.sources.map(source => ({ registry_id: source.registry_id, platform: 'youtube' as const, display_name: source.display_name, verification_status: source.collection_status, accountId: source.channel_id })),
  ...videos.bilibili_sources.map(source => ({ registry_id: source.registry_id, platform: 'bilibili' as const, display_name: source.display_name, verification_status: source.collection_status, accountId: source.uid })),
];
export const historicalSources: RegisteredSource[] = wechat.retired_sources.map(source => ({ ...source, platform: 'wechat' as const }));
export function registeredSource(id: string) { return [...registeredSources, ...historicalSources].find(source => source.registry_id === id); }
export function defaultSubscriptions(): SubscriptionConfig[] {
  return registeredSources.map(source => ({ id: source.registry_id, platform: source.platform, name: source.display_name, accountId: source.accountId,
    enabled: false, feedUrl: '', topic: null, intervalMinutes: 60, summaryIsBody: false }));
}
