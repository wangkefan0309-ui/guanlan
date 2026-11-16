import type { Material, ReadingItem } from './model';
import { beijingDate } from './daily';
import { subscriptionUpdates, updateSourceId, type UpdateSource } from './updates';

export function publicationDay(item: Pick<Material, 'publishedAt'>): string | null {
  if (!item.publishedAt) return null;
  const time = Date.parse(item.publishedAt);
  return Number.isFinite(time) ? beijingDate(new Date(time)) : null;
}
export function dayDisposition(item: Pick<Material, 'publishedAt'>, day: string): 'today' | 'older' | 'future' | 'undated' {
  const published = publicationDay(item);
  return !published ? 'undated' : published === day ? 'today' : published < day ? 'older' : 'future';
}
export function publicationItems(items:ReadingItem[],sources:UpdateSource[]):ReadingItem[]{
  return items.map(item=>{const source=sources.find(source=>source.registry_id===updateSourceId(item,sources));const dates=source?.publicationDates;
    return item.url&&dates&&Object.hasOwn(dates,item.url)?{...item,publishedAt:dates[item.url]??undefined}:item;});
}
export function updatesForDay(items: ReadingItem[], sources: UpdateSource[], day: string) {
  const today = beijingDate();
  return subscriptionUpdates(publicationItems(items,sources).filter(item=>{
    const source=sources.find(source=>source.registry_id===updateSourceId(item,sources));
    // Imported RSS records remain archived while today's author dates are verified.
    if(day===today&&source?.platform==='wechat'&&source.publicationDates!==undefined&&(!item.url||!source.publicationDates[item.url]))return false;
    return publicationDay(item)===day;
  }),sources);
}
/** Group the archive once instead of rescanning it for each calendar day. */
export function updatesByDay(items: ReadingItem[], sources: UpdateSource[], today = beijingDate()): Map<string, ReadingItem[]> {
  const days = new Map<string, ReadingItem[]>();
  for (const item of publicationItems(items, sources)) {
    const day = publicationDay(item);
    if (!day) continue;
    const source = sources.find(source => source.registry_id === updateSourceId(item, sources));
    if (day === today && source?.platform === 'wechat' && source.publicationDates !== undefined && (!item.url || !source.publicationDates[item.url])) continue;
    const group = days.get(day) ?? []; group.push(item); days.set(day, group);
  }
  return new Map([...days].map(([day, group]) => [day, subscriptionUpdates(group, sources)]));
}
// Daily pages include quiet days. Start at actual collection activation, never at an old test item's capture time.
export function subscriptionDays(startedAt?: string, now = new Date(), archivedDays: readonly string[] = []): string[] {
  const today = beijingDate(now), start = startedAt && Number.isFinite(Date.parse(startedAt)) ? beijingDate(new Date(startedAt)) : today;
  const days: string[] = [];
  const lower = Math.min(Date.parse(start), Date.parse(today));
  for (let time = Date.parse(today); time >= lower && days.length < 3660; time -= 86400_000) days.push(new Date(time).toISOString().slice(0, 10));
  for(const day of archivedDays){const time=Date.parse(day);if(Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===day&&day<=today)days.push(day);}
  return [...new Set(days)].sort().reverse();
}
export function archiveDays(items:ReadingItem[],sources:UpdateSource[],startedAt?:string,now=new Date()){
  const known=new Set(sources.map(source=>source.registry_id).filter(Boolean));
  const days=publicationItems(items,sources).filter(item=>known.has(updateSourceId(item,sources))).map(publicationDay).filter((date):date is string=>date!==null);
  return subscriptionDays(startedAt,now,days);
}
