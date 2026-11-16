import { candidateUrl } from './exploration-search';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
export function originalXPost(raw: unknown, id: string): ObjectValue | undefined {
  const pending = [raw]; let visited = 0;
  while (pending.length && visited++ < 100_000) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object') pending.push(child); }
    else if (value && typeof value === 'object') {
      const entry = object(value);
      if (entry.rest_id === id && entry.legacy && typeof entry.legacy === 'object') return entry;
      for (const child of Object.values(entry)) if (child && typeof child === 'object') pending.push(child);
    }
  }
  return undefined;
}
export function xContent(raw: unknown, id: string, fallbackEntities: unknown) {
  const original = originalXPost(raw, id), legacy = object(original?.legacy);
  const note = object(object(object(original?.note_tweet).note_tweet_results).result);
  const arrays = [object(fallbackEntities).urls, object(legacy.entities).urls, object(note.entity_set).urls];
  const links: { url: string; label: string; kind: 'video' | 'article' }[] = [];
  for (const values of arrays) for (const value of Array.isArray(values) ? values : []) {
    if (links.length >= 4) break;
    const url = candidateUrl(String(object(value).expanded_url ?? '')); if (!url || links.some(link => link.url === url)) continue;
    const host = new URL(url).hostname;
    const video = ['youtube.com', 'youtu.be', 'bilibili.com'].some(domain => host === domain || host.endsWith(`.${domain}`));
    links.push({ url, label: video ? '帖子中的视频链接' : '帖子中的原始链接', kind: video ? 'video' : 'article' });
  }
  const videos = (Array.isArray(object(legacy.extended_entities).media) ? object(legacy.extended_entities).media as unknown[] : []).filter(value => object(value).type === 'video');
  const durations = videos.map(value => object(object(value).video_info).duration_millis).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 604800_000);
  const media = videos.length ? { kind: 'video' as const, durationSeconds: durations.length ? Math.floor(Math.max(...durations) / 1000) || undefined : undefined } : undefined;
  return { original, media, links: links.slice(0, 4) };
}
