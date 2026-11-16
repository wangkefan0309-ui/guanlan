import { z } from 'zod';
import { discoveryTopicsSchema } from './discovery-topics';
import { topics, webUrl } from './model';

export const freeXRequestSchema = z.object({ topics: discoveryTopicsSchema }).strict();
export const freeXPostSchema = z.object({ url: webUrl, topic: z.enum(topics).default('ai-learning') }).strict();
export const freeXStatusSchema = z.object({
  provider: z.literal('twscrape'), configured: z.boolean(), verified: z.boolean(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requestsToday: z.number().int().min(0).max(3),
  returnedPosts: z.number().int().nonnegative(), paused: z.boolean(), reason: z.string().max(500),
}).strict();
export type FreeXStatus = z.infer<typeof freeXStatusSchema>;
