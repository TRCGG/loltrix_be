import { z } from 'zod';

export const monthSchema = z
  .string()
  .regex(/^\d{1,2}$/, 'Month must be 1 or 2 digits')
  .refine((value) => {
    const month = Number(value);
    return month >= 1 && month <= 12;
  }, 'Month must be between 1 and 12');

/** datePreset=range는 월 범위와 시즌이 모두 있어야 해석된다. 없으면 최근 1개월로 조용히 떨어진다. */
export const rangeRequiresMonths = (
  query: { datePreset?: string; fromMonth?: string; toMonth?: string; season?: string },
  ctx: z.RefinementCtx,
) => {
  if (query.datePreset !== 'range') {
    return;
  }

  (['fromMonth', 'toMonth', 'season'] as const).forEach((field) => {
    if (!query[field]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} is required when datePreset=range`,
        path: [field],
      });
    }
  });
};
