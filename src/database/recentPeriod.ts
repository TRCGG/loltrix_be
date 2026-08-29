import { sql, SQL } from 'drizzle-orm';
import { AnyPgColumn } from 'drizzle-orm/pg-core';

/** 'recent'=최근 1개월, 'season'·생략=시즌 전체. */
export type DatePreset = 'recent' | 'season';

/** '최근'의 경계. 통계 화면과 챔피언 탭이 같은 값을 써야 두 곳의 '최근'이 갈리지 않는다. */
export const recentPeriodCondition = (createDate: AnyPgColumn): SQL =>
  sql`${createDate} >= NOW() - INTERVAL '1 month'`;
