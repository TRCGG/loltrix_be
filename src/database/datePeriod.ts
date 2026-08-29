import { and, gte, or, sql, SQL } from 'drizzle-orm';
import { AnyPgColumn } from 'drizzle-orm/pg-core';

/** 'recent'=최근 1개월, 'season'=시즌 전체, 'range'=월 범위. */
export type DatePreset = 'recent' | 'season' | 'range';

/**
 * 조회 기간 → WHERE 조각. 통계 화면과 챔피언 탭이 같은 정의를 써야 두 곳의 '최근'이 갈리지 않는다.
 * 기본값(preset 미지정 시 무엇으로 볼지)은 호출부가 정한다 — statistics는 recent, most-picks는 시즌 전체다.
 *
 * range는 연도를 보지 않고 월(1~12)만 비교한다. 시즌 조건과 AND로 걸리므로 결과적으로 시즌 안의 월 범위가 된다.
 */
export function periodCondition(
  createDate: AnyPgColumn,
  datePreset: DatePreset,
  fromMonth?: string,
  toMonth?: string,
): SQL | undefined {
  if (datePreset === 'season') {
    return undefined;
  }

  if (datePreset === 'range' && fromMonth && toMonth) {
    const from = Number(fromMonth);
    const to = Number(toMonth);
    const monthExpr = sql<number>`EXTRACT(MONTH FROM ${createDate})::integer`;

    return from <= to
      ? and(gte(monthExpr, from), sql`${monthExpr} <= ${to}`)
      : or(gte(monthExpr, from), sql`${monthExpr} <= ${to}`);
  }

  return sql`${createDate} >= NOW() - INTERVAL '1 month'`;
}
