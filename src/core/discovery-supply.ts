import { canonicalIdentity, hash, type ReadingItem } from './model';
import { beijingDate } from './daily';
import type { DiscoveryTopic } from './discovery-topics';
import { searchResultSchema, type ExplorationCandidate, type ExplorationSearchResult } from './exploration';

/** Public technical indexes need one search direction, not an AND of every interest. */
export function publicSearchQuery(query: string, now: Date, index: number): string {
  if (!/[\u4e00-\u9fff]/.test(query) || query.trim().split(/\s+/).length < 4) return query;
  const directions = [
    [/国内|中国/, 'China'], [/国际|全球/, 'geopolitics'], [/商业|创业/, 'startup'],
    [/投资|资产/, 'investing'], [/财经|经济/, 'economy'], [/生活|健康/, 'health'],
    [/认知|成长|学习/, 'learning'], [/科技|人工智能|\bAI\b/i, 'AI'],
  ] as const;
  const matched = directions.filter(([pattern]) => pattern.test(query)).map(([, term]) => term);
  if (matched.length < 2) return query;
  const day = Math.floor(Date.parse(`${beijingDate(now)}T00:00:00Z`) / 86_400_000);
  return matched[(day + index) % matched.length]!;
}

export function subscriptionSection(item: ReadingItem, enabled: DiscoveryTopic[]): DiscoveryTopic | undefined {
  const choices: DiscoveryTopic[] = item.topic === 'ai-news' || item.topic === 'ai-learning' ? ['technology']
    : item.topic === 'finance' ? ['finance', 'investing', 'business']
      : item.topic === 'headlines' ? (/国际|美国|欧洲|全球|world/i.test(item.title) ? ['international', 'domestic'] : ['domestic', 'international'])
        : item.topic === 'cognition' ? ['growth'] : item.topic === 'opinion' ? ['growth', 'life'] : ['life'];
  return choices.find(section => enabled.includes(section));
}

/** Real saved text is a fallback candidate, not an invented search result or an AI pass. */
export async function subscriptionDiscoveryCandidates(items: ReadingItem[], sections: DiscoveryTopic[], now = new Date(), excludedIds = new Set<string>()): Promise<ExplorationSearchResult> {
  const latest = new Map<string, ReadingItem>();
  for (const item of items) latest.set(item.id, item);
  const candidates: ExplorationCandidate[] = [], snapshots: ExplorationSearchResult['snapshots'] = [];
  const selected = [...latest.values()].filter(item => {
    const date = Date.parse(item.publishedAt ?? item.capturedAt);
    return item.url && item.purpose === 'reading' && ['unread', 'later'].includes(item.progress) && item.coverage !== 'metadata' && item.body.trim().length >= 80
      && Number.isFinite(date) && date >= now.getTime() - 7 * 86_400_000 && date <= now.getTime() && subscriptionSection(item, sections);
  }).sort((a, b) => Date.parse(b.publishedAt ?? b.capturedAt) - Date.parse(a.publishedAt ?? a.capturedAt));
  // Round robin authors, so a prolific subscription cannot consume all fallback places.
  const groups = new Map<string, ReadingItem[]>();
  for (const item of selected) { const group = groups.get(item.source) ?? []; group.push(item); groups.set(item.source, group); }
  while (candidates.length < 6) {
    let added = false;
    for (const group of groups.values()) {
      const item = group.shift(); if (!item) continue; added = true;
      const url = canonicalIdentity(item.url!), excerpt = item.body.slice(0, 2400), id = await hash(url);
      if (!excludedIds.has(id) && !candidates.some(c => c.url === url)) {
        candidates.push({ id, title: item.title.slice(0, 240), source: item.source.slice(0, 160), url, excerpt,
          evidence: excerpt.match(/[\s\S]{1,600}/g)!.slice(0, 4), date: item.publishedAt, dateKind: item.publishedAt ? 'published' : 'unknown',
          query: '近期未读订阅正文补充', coverage: 'page-excerpt', origin: 'subscription' });
        snapshots.push({ source: '已同步订阅正文', query: '近期未读订阅正文补充', json: JSON.stringify({ id: item.id, version: item.version, path: item.path, originalHash: item.originalHash, excerpt }) });
      }
      if (candidates.length === 6) break;
    }
    if (!added) break;
  }
  return searchResultSchema.parse({ candidates, snapshots, warnings: [], credits: 0 });
}
