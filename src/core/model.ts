import { z } from 'zod';
import { reviewReceiptSchema } from './daily-model';
import { historyDaysSchema } from './history';

export const legacyTopics = ['ai-learning', 'ai-news', 'finance', 'law', 'headlines', 'leisure'] as const;
export const topics = [...legacyTopics, 'cognition', 'opinion'] as const;
export const topicLabels: Record<Topic, string> = {
  'ai-learning': 'AI 应用与基础', 'ai-news': 'AI 资讯', finance: '财经金融', law: '法律', headlines: '热点速览',
  leisure: '娱乐与生活', cognition: '认知', opinion: '观点',
};
export type Topic = typeof topics[number];
export const categoryIdSchema = z.string().regex(/^(ai-learning|ai-news|finance|law|headlines|leisure|cognition|opinion|cat-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
export const webUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, '需要没有用户名及密码的 HTTP/HTTPS 链接');
const materialBase = z.object({
  title: z.string().trim().min(1).max(240),
  source: z.string().trim().min(1).max(160),
  sourceId: z.string().regex(/^(WX|YT|BL|RSS)-(\d{3}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/).optional(),
  categoryId: categoryIdSchema.optional(),
  categoryName: z.string().trim().min(1).max(60).optional(),
  url: webUrl.optional(),
  identity: z.string().min(1).max(4096),
  topic: z.enum(topics),
  kind: z.enum(['article', 'pdf', 'markdown']),
  purpose: z.enum(['reading', 'validation']).default('reading'),
  publishedAt: z.string().max(80).optional(),
  capturedAt: z.string().datetime(),
  body: z.string().max(1_500_000),
  coverage: z.enum(['full', 'partial', 'metadata']),
  gaps: z.array(z.string().max(500)).max(40).default([]),
  guide: z.string().max(6000).default(''),
  guideKind: z.enum(['excerpt', 'ai', 'none']).default('none'),
  original: z.object({
    extension: z.enum(['html', 'pdf', 'md', 'srt', 'vtt', 'json']),
    base64: z.string().max(36_000_000),
  }).optional(),
}).strict();
function validateMaterial(value: z.infer<typeof materialBase>, ctx: z.RefinementCtx) {
  if (value.coverage !== 'metadata' && !value.body.trim()) ctx.addIssue({ code: 'custom', path: ['body'], message: '正文为空时应标记为仅元数据' });
  if (value.coverage === 'metadata' && value.guideKind === 'ai') ctx.addIssue({ code: 'custom', path: ['guideKind'], message: '没有正文不能生成全文导读' });
  if (value.original && (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.original.base64) || value.original.base64.length % 4 !== 0)) ctx.addIssue({ code: 'custom', path: ['original'], message: '原件编码无效' });
}
export const materialSchema = materialBase.superRefine(validateMaterial);
export type Material = z.infer<typeof materialSchema>;

export const itemSchema = materialBase.omit({ original: true }).extend({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  path: z.string(),
  originalPath: z.string().optional(),
  originalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  progress: z.enum(['unread', 'later', 'reading', 'done']).default('unread'),
  position: z.string().max(1000).default(''),
  savedAt: z.string().datetime(),
}).superRefine(validateMaterial);
export type ReadingItem = z.infer<typeof itemSchema>;
export const feedSchema = z.object({
  instance: z.string().min(1).max(120),
  cursor: z.number().int().nonnegative(),
  items: z.array(materialSchema).max(200),
  hasMore: z.boolean().default(false),
}).strict();
export type Feed = z.infer<typeof feedSchema>;
export const dialogueSchema = z.object({
  id: z.string(), version: z.string(), model: z.string().max(240),
  records: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().max(100_000) })).max(200),
  path: z.string(),
});
export const stateSchema = z.object({
  schema: z.literal(1),
  items: z.array(itemSchema),
  trash: z.array(z.object({ item: itemSchema, deletedAt: z.string().datetime() })).default([]),
  feedInstance: z.string().default(''),
  cursor: z.number().int().nonnegative().default(0),
  dailyHash: z.string().default(''),
  dialogues: z.array(dialogueSchema).default([]),
  conflicts: z.array(z.string()).default([]),
  reviews: z.array(reviewReceiptSchema).default([]),
  historyDays: historyDaysSchema,
});
export type LibraryState = z.infer<typeof stateSchema>;
export interface FileStore {
  read(path: string): Promise<string | null>;
  // expected=null creates only; a string replaces only those exact contents.
  write(path: string, contents: string, expected?: string | null): Promise<void>;
  readBinary(path: string): Promise<Uint8Array | null>;
  writeBinary(path: string, contents: Uint8Array): Promise<void>;
  remove?(path: string): Promise<void>;
}
export async function hash(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(data));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function decodeBase64(value: string): Uint8Array {
  const native = (Uint8Array as typeof Uint8Array & {fromBase64?: (value:string)=>Uint8Array}).fromBase64;
  if(native)return native(value);
  if(typeof Buffer!=='undefined'){const bytes=Buffer.from(value,'base64');return new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);}
  const binary=atob(value),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return bytes;
}
export async function materialVersion(material: Material, originalBytes?: Uint8Array, legacy = false): Promise<string> {
  const original = material.original && (material.kind === 'pdf' || material.coverage === 'metadata') ? await hash(originalBytes ?? decodeBase64(material.original.base64)) : '';
  return hash(JSON.stringify({title:material.title,source:material.source,kind:material.kind,purpose:material.purpose,body:material.body,coverage:material.coverage,gaps:material.gaps,original,...(!legacy && material.publishedAt ? {publishedAt:material.publishedAt} : {})}));
}
export function canonicalIdentity(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value); url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|scene$|from$|isappinstalled$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); return url.toString();
}
export function readingRoot(value: string): string {
  const path = value.trim().replace(/[\u00a0\u202f]/g,' ').normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /^[a-z][：:]/i.test(path) || /[:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part!==part.trim() || part.startsWith('.') || /[<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error('阅读目录必须是 Vault 内的普通相对目录');
  if (/^(01_帆OS|02_Inbox|07_Claudian Settings|08_LLM Wiki)(\/|$)/i.test(path) || /Rocker|摇杆/i.test(path)) throw new Error('请选择独立阅读目录，例如 09_信息源');
  return path;
}
export function checkReadingPath(root: string, path: string): void {
  if (!path.startsWith(`${root}/`) || readingRoot(path) !== path) throw new Error('材料路径越过阅读目录，请检查工作台状态');
}
export const coverageLabels = { full: '正文已提取', partial: '部分正文', metadata: '正文未取得' };
export function safeLink(url: string): string { return `<${webUrl.parse(url).replace(/>/g, '%3E')}>`; }
export function escapeLine(text: string): string { return text.replace(/[\r\n]/g, ' ').replace(/[\[\]<>]/g, ''); }
