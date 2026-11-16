import type { ReadingItem } from '../core/model';
import type { KnowledgeStatus } from '../core/knowledge';

export type KnowledgeLane = 'pending' | 'discussion' | 'complete' | 'issue' | 'cancelled';
export function knowledgeLane(status: KnowledgeStatus): KnowledgeLane {
  if (status.issue || /失败|需检查|需核对/.test(status.label)) return 'issue';
  if (status.label === '已取消待处理') return 'cancelled';
  if (status.label === '等待讨论') return 'discussion';
  if (['Wiki 已归纳', 'fanOS 已晋升'].includes(status.label)) return 'complete';
  return 'pending';
}
// Library order is the committed version order, also used by the daily plan.
export function latestItems(items: ReadingItem[]): ReadingItem[] {
  const latest = new Map<string, ReadingItem>();
  for (const item of items) latest.set(item.id, item);
  return [...latest.values()];
}
const publicationFormatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export function publicationLabel(item: Pick<ReadingItem, 'publishedAt' | 'capturedAt'>): string {
  if (!item.publishedAt) return '发布时间未知';
  const date = new Date(item.publishedAt);
  return Number.isFinite(date.getTime()) ? publicationFormatter.format(date) : '发布时间待核对';
}
export function isVideoLink(item: Pick<ReadingItem, 'identity' | 'coverage'>): boolean {
  return isVideoMaterial(item) && item.coverage === 'metadata';
}
export function isVideoMaterial(item:Pick<ReadingItem,'identity'>):boolean{return /^(youtube|bilibili):/.test(item.identity);}
export function previewText(text: string, limit = 160): string {
  return text.slice(0, 4000).replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*(?:\)|$)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
