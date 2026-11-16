import { z } from 'zod';

export const youtubeAccessUpdateSchema = z.union([
  z.object({ revision: z.string().uuid(), key: z.string().trim().regex(/^[A-Za-z0-9_-]{20,200}$/, '请输入完整的YouTube API密钥') }).strict(),
  z.object({ revision: z.string().uuid(), clear: z.literal(true) }).strict(),
]);
export const youtubeAccessViewSchema = z.object({
  revision: z.string().uuid(), configured: z.boolean(), verifiedAt: z.string().datetime().nullable(),
  requestsToday: z.number().int().nonnegative(), dailyLimit: z.literal(1000), paused: z.boolean(), lastError: z.string(),
}).strict();
export type YoutubeAccessView = z.infer<typeof youtubeAccessViewSchema>;
