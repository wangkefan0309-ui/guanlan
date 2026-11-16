import type { ReadingItem, Material } from './model';

export interface UpdateSource { registry_id?: string; display_name: string; original_name?: string; platform?: string; publicationDates?: Record<string,string|null> }
export function updateSourceId(item: Pick<Material, 'sourceId' | 'source' | 'url'>, sources: UpdateSource[]): string | undefined {
  if (item.sourceId) return item.sourceId;
  if (!item.url) return;
  const hostname = new URL(item.url).hostname;
  const matches = sources.filter(source => (source.display_name === item.source || source.original_name === item.source) &&
    (source.platform === 'wechat' ? hostname === 'mp.weixin.qq.com' : source.platform === 'youtube' ? ['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(hostname) : source.platform === 'bilibili' && ['www.bilibili.com', 'bilibili.com'].includes(hostname)));
  return matches.length === 1 ? matches[0]?.registry_id : undefined;
}

// User-specified priorities: 1 is highest; video sources have no implied article priority.
export const sourcePriorities: Record<string, number> = {
  'WX-004': 1, 'WX-003': 1, 'WX-002': 1,
  'WX-001': 2, 'WX-006': 2, 'WX-008': 2, 'WX-009': 2,
  'WX-007': 3, 'WX-010': 3, 'WX-011': 3,
};
export function subscriptionUpdates(items: ReadingItem[], sources: UpdateSource[], priorities: Record<string, number> = sourcePriorities): ReadingItem[] {
  const latest = new Map<string, ReadingItem>();
  const known = new Set(sources.map(source => source.registry_id).filter(Boolean));
  for (const item of items) if (known.has(updateSourceId(item, sources))) latest.set(item.id, item);
  return [...latest.values()].sort((a, b) => (priorities[updateSourceId(a, sources)!] ?? 4) - (priorities[updateSourceId(b, sources)!] ?? 4) || Date.parse(b.publishedAt ?? b.capturedAt) - Date.parse(a.publishedAt ?? a.capturedAt));
}
