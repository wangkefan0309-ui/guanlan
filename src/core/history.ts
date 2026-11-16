import { z } from 'zod';
import { canonicalIdentity, type ReadingItem } from './model';
import type { ReviewReceipt } from './daily-model';
import { sourcePriorities, updateSourceId, type UpdateSource } from './updates';

const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(day => Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day);
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const historyDaySchema = z.object({
  date: daySchema, createdAt: z.string().datetime(), maxItems: z.number().int().min(1).max(5),
  picks: z.array(z.object({ id: keySchema, version: keySchema, reason: z.string().min(1).max(240) }).strict()).max(5),
}).strict().refine(day => new Set(day.picks.map(pick => pick.id)).size === day.picks.length && day.picks.length <= day.maxItems);
export const historyDaysSchema = z.array(historyDaySchema).default([]).refine(days => new Set(days.map(day => day.date)).size === days.length, '历史精选日期重复');
export type HistoryDay = z.infer<typeof historyDaySchema>;
export interface HistoryArchive { date: string; days: HistoryDay[]; remainingCount: number; rotatedCount: number }
export interface HistoryOptions { maxItems?: number; excludedUrls?: string[]; sources?: UpdateSource[] }

export function historyCandidates(items: ReadingItem[], date: string): ReadingItem[] {
  const latest = new Map<string, ReadingItem>();
  for (const item of items) latest.set(item.id, item);
  return [...latest.values()].filter(item => {
    if (item.purpose !== 'reading' || item.progress === 'done' || (item.coverage === 'metadata' && !item.url)) return false;
    // Unknown publication dates stay unknown; savedAt is only a local eligibility boundary.
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const time = Number.isFinite(published) ? published : Date.parse(item.savedAt);
    return Number.isFinite(time) && dayFormat.format(new Date(time)) < date;
  });
}

/** Two complementary slots: value first, then the oldest unexposed material. */
export function selectHistoryDay(items: ReadingItem[], days: HistoryDay[], reviews: ReviewReceipt[], options: HistoryOptions, now: string): HistoryDay {
  const date = dayFormat.format(new Date(now)), maxItems = z.number().int().min(1).max(5).parse(options.maxItems ?? 2);
  const counts = new Map<string, number>(), last = new Map<string, string>(), scores = new Map<string, number>();
  for (const day of days.filter(day => day.date < date)) for (const pick of day.picks) {
    counts.set(pick.id, (counts.get(pick.id) ?? 0) + 1);
    if ((last.get(pick.id) ?? '') < day.date) last.set(pick.id, day.date);
  }
  for (const review of reviews) if (review.status === 'completed') for (const entry of review.entries) if (entry.label === 'PASS') scores.set(`${entry.id}:${entry.version}`, entry.score);
  const excluded = new Set((options.excludedUrls ?? []).map(canonicalIdentity));
  const pool = historyCandidates(items, date).filter(item => {
    if (item.url && excluded.has(canonicalIdentity(item.url))) return false;
    const previous = last.get(item.id);
    return !previous || Date.parse(date) - Date.parse(previous) >= (item.progress === 'later' ? 14 : 7) * 86_400_000;
  });
  const picks: HistoryDay['picks'] = [], authors = new Set<string>();
  const age = (item: ReadingItem) => Date.parse(item.publishedAt ?? '') || Date.parse(item.savedAt);
  const value = (item: ReadingItem) => {
    const staleNews = ['ai-news', 'headlines'].includes(item.topic) && Date.parse(date) - age(item) > 7 * 86_400_000;
    return (item.progress === 'reading' ? 60 : item.progress === 'later' ? -30 : 0)
      + (4 - (sourcePriorities[updateSourceId(item, options.sources ?? []) ?? ''] ?? 4)) * 10
      + (scores.get(`${item.id}:${item.version}`) ?? 50) / 5 - (staleNews ? 35 : 0);
  };
  while (pool.length && picks.length < maxItems) {
    const minCount = pool.reduce((minimum, item) => Math.min(minimum, counts.get(item.id) ?? 0), Infinity);
    const tier = pool.filter(item => (counts.get(item.id) ?? 0) === minCount);
    const diverse = tier.filter(item => !authors.has(item.sourceId ?? item.source));
    // A one-item budget alternates by date. Diversity must never starve the oldest slot.
    const rotate = maxItems === 1 ? Math.floor(Date.parse(date) / 86_400_000) % 2 === 1 : picks.length % 2 === 1;
    const choices = rotate ? tier : diverse.length ? diverse : tier;
    const oldest = (a: ReadingItem, b: ReadingItem) => age(a) - age(b) || Date.parse(a.savedAt) - Date.parse(b.savedAt);
    choices.sort((a, b) => (rotate ? oldest(a, b) || Number(authors.has(a.sourceId ?? a.source)) - Number(authors.has(b.sourceId ?? b.source)) || value(b) - value(a) : value(b) - value(a) || oldest(a, b)) || a.id.localeCompare(b.id));
    const item = choices[0]!;
    picks.push({ id: item.id, version: item.version, reason: rotate ? '历史轮换：优先补到较早、较少推荐的材料' : item.progress === 'reading' ? '接着上次的位置继续读' : '结合来源优先级、已有评价与推荐次数选择' });
    authors.add(item.sourceId ?? item.source); pool.splice(pool.indexOf(item), 1);
  }
  return historyDaySchema.parse({ date, createdAt: now, maxItems, picks });
}
