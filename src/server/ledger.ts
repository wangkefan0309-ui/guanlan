import { z } from 'zod';
import { materialSchema } from '../core/model';
export const ledgerSchema = z.object({ instance: z.string(), entries: z.array(z.object({ seq: z.number().int(), version: z.string(), material: materialSchema })) });
