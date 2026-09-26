import { z } from 'zod';
import { monthSchema, rangeRequiresMonths } from './monthQuery.js';

const periodQuery = z.object({
  datePreset: z.enum(['recent', 'recent30', 'season', 'range']).optional(),
  fromMonth: monthSchema.optional(),
  toMonth: monthSchema.optional(),
  season: z.string().min(1).max(32).optional(),
});
const pagination = {
  page: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
    .optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
};
const params = z.object({ guildId: z.string().min(1).max(128) });

export const combinationFilterSchema = z.object({
  params,
  query: periodQuery
    .extend({
      ...pagination,
      combination: z.enum(['ADCSUP', 'MIDJUG']),
    })
    .superRefine(rangeRequiresMonths),
});

export const duoFilterSchema = z.object({
  params,
  query: periodQuery.extend(pagination).superRefine(rangeRequiresMonths),
});

export const activityFilterSchema = z.object({
  params,
  query: periodQuery.superRefine(rangeRequiresMonths),
});
