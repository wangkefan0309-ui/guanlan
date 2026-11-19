import { z } from 'zod';
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export const defaultLearningGoals = 'AI 应用与基础：文科背景，结合已有 Agent 使用场景解释概念和实践。AI 资讯：关注工具、模型的实际变化。财经金融：从零基础概念逐步读报告。法律：法学本科阶段，保留法域、规范状态与日期。热点少量速览。';
export const dailyOptionsSchema = z.object({
  budgetMinutes: z.number().int().min(5).max(180).default(50),
  maxItems: z.number().int().min(1).max(5).default(3),
  goals: z.string().trim().min(1).max(2000).default(defaultLearningGoals),
}).strict();
export type DailyOptions = z.infer<typeof dailyOptionsSchema>;
export const reviewEntrySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), version: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.enum(['PASS', 'BLOCK', 'UNKNOWN']), score: z.number().int().min(0).max(100),
  reason: z.string().trim().min(1).max(240), guide: z.string().trim().min(1).max(600),
  quote: z.string().trim().min(1).max(200),
  sampledChars: z.number().int().positive().max(2400), totalChars: z.number().int().positive(),
}).strict();
export type ReviewEntry = z.infer<typeof reviewEntrySchema>;
export const reviewUsageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() });
export const reviewResponseSchema = z.object({ content: z.string().min(1).max(100_000), usage: reviewUsageSchema.optional() }).strict();
export const reviewReceiptSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), contextHash: z.string().regex(/^[a-f0-9]{64}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), createdAt: z.iso.datetime(),
  model: z.string().min(1).max(240), endpoint: z.string().max(4096), promptVersion: z.string().max(120),
  keys: z.array(z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/)).min(1).max(12),
  status: z.enum(['started', 'completed', 'failed']), entries: z.array(reviewEntrySchema).max(12).default([]),
  usage: reviewUsageSchema.optional(),
  path: z.string().optional(), error: z.string().max(500).optional(),
}).strict();
export type ReviewReceipt = z.infer<typeof reviewReceiptSchema>;
export const reviewRequestSchema = reviewReceiptSchema.omit({ status: true, entries: true, usage: true, path: true, error: true }).strip();
