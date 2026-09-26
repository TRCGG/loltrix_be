import { sql } from 'drizzle-orm';
import { AnyPgColumn } from 'drizzle-orm/pg-core';
import { DatePreset, periodCondition } from './datePeriod.js';

export type LeaderboardDatePreset = DatePreset | 'recent30';

export function clanLeaderboardPeriodCondition(
  createDate: AnyPgColumn,
  datePreset: LeaderboardDatePreset | undefined,
  fromMonth?: string,
  toMonth?: string,
) {
  const preset = datePreset ?? 'recent';
  if (preset === 'recent30' || preset === 'recent') {
    return sql`${createDate} >= NOW() - INTERVAL '30 days'`;
  }
  return periodCondition(createDate, preset, fromMonth, toMonth);
}
