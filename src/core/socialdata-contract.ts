import { z } from 'zod';
import { discoveryTopicsSchema } from './discovery-topics';

export const socialDataRequestSchema = z.object({ key: z.string().trim().min(1).max(8192), topics: discoveryTopicsSchema }).strict();
export const socialDataStatusSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/), limitUsd: z.literal(0.5),
  spentUsd: z.number().nonnegative(), reservedUsd: z.number().nonnegative(), availableUsd: z.number().nonnegative(),
  requestsToday: z.number().int().min(0).max(3), paused: z.boolean(), reason: z.string().max(500),
}).strict();
export type SocialDataStatus = z.infer<typeof socialDataStatusSchema>;
