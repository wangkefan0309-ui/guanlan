import { z } from 'zod';

export const collectionIssueKindSchema = z.enum(['network', 'authorization', 'rate-limit', 'verification', 'content', 'storage', 'unknown']);
export type CollectionIssueKind = z.infer<typeof collectionIssueKindSchema>;
export const subscriptionCheckSchema = z.object({
  checkedAt: z.string().datetime(), status: z.enum(['ok', 'error', 'waiting']),
  kind: collectionIssueKindSchema.optional(), message: z.string().max(600),
}).strict();

/** Check restrictions before network keywords: fallback messages can contain both. */
export function collectionIssueKind(message: string): CollectionIssueKind {
  if (/HTTP\s*(?:429|412)|200013|限流|配额|请求上限|风控/i.test(message)) return 'rate-limit';
  if (/HTTP\s*(?:401|403)|授权|密钥|API.?Key|登录|启用状态/i.test(message)) return 'authorization';
  if (/EPERM|EACCES|EBUSY|ENOSPC|保存失败|写入失败|回执写入|存储错误|文件冲突/i.test(message)) return 'storage';
  if (/需要验证|安全验证|验证码/.test(message)) return 'verification';
  if (/\b(?:TLS|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ENOTFOUND|network|fetch failed|timed?\s*out)\b|HTTP\s*(?:408|5\d\d)|网络|超时|连接失败|连接中断|响应中断/i.test(message)) return 'network';
  if (/正文|账号不匹配|账号信息不完整|XML|JSON|身份|未返回|无法核验/i.test(message)) return 'content';
  return 'unknown';
}

export function collectionIssueAdvice(message: string): string {
  return {
    network: '网络或上游服务暂不可用，后台会自动重试，无需重新配置密钥或订阅',
    authorization: '请检查对应来源的授权或密钥配置',
    'rate-limit': '上游限制请求，后台按退避时间再检查，请勿连续刷新',
    verification: '原页面要求验证，后台稍后再检查；持续失败时查看原页面',
    content: '返回内容暂不能通过核验，保留已有材料并稍后再检查',
    storage: '材料或回执保存失败，请检查本机存储与文件占用',
    unknown: '检查尚未完成，后台会按计划再尝试；持续失败时查看失败记录',
  }[collectionIssueKind(message)];
}

export function redactCollectionError(message: string): string {
  return message.replace(/https?:\/\/[^\s<>"']+/gi, '<URL>')
    .replace(/\bBearer\s+\S+/gi, 'Bearer <REDACTED>')
    .replace(/\b(?:key|token|secret|password|cookie)\s*[:=]\s*[^\s;,]+/gi, '<凭据已隐藏>').slice(0, 600);
}

export function subscriptionStatusText(source: { status: string; error: string; nextDue: string | null }): string {
  const label = ({ 'not-configured': '未配置更新链接', paused: '订阅已暂停', waiting: '等待检查', running: '正在采集', ok: '最近检查成功' } as Record<string, string>)[source.status];
  if (source.status !== 'error') return label ?? '状态待核对';
  const due = source.nextDue ? `；计划 ${new Date(source.nextDue).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 重试` : '';
  return `${collectionIssueAdvice(source.error)}${due}`;
}
