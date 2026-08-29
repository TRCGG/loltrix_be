import { eq, inArray, SQL } from 'drizzle-orm';
import { AnyPgColumn } from 'drizzle-orm/pg-core';
import { GameType, MatchScope } from '../types/matchScope.js';
import { periodCondition } from './datePeriod.js';

/** alias는 tableName 리터럴이 달라져 구체 컬럼 타입으로는 못 받는다. */
type ScopeColumns = {
  gameType: AnyPgColumn;
  competitionId: AnyPgColumn;
  season: AnyPgColumn;
  createDate: AnyPgColumn;
};

const gameTypeCondition = (column: AnyPgColumn, gameTypes: GameType[]): SQL =>
  gameTypes.length === 1 ? eq(column, gameTypes[0]) : inArray(column, gameTypes);

/**
 * custom_match용 scope → WHERE 조각. and(...)에 펼쳐 넣는다.
 * season은 competitionId가 없을 때만 적용되고, null/undefined면 시즌 조건 없음(전체).
 */
export function scopeConditions(
  t: ScopeColumns,
  scope: MatchScope,
  season?: string | null,
): (SQL | undefined)[] {
  const typeCondition = gameTypeCondition(t.gameType, scope.gameTypes);
  if (scope.competitionId != null) {
    return [typeCondition, eq(t.competitionId, scope.competitionId)];
  }

  const conditions: (SQL | undefined)[] = [
    typeCondition,
    season ? eq(t.season, season) : undefined,
  ];
  const period = scope.datePreset
    ? periodCondition(t.createDate, scope.datePreset, scope.fromMonth, scope.toMonth)
    : undefined;
  if (period) {
    conditions.push(period);
  }
  return conditions;
}

/**
 * mmr_participant_metric(및 alias)용. 이 테이블엔 competition_id가 없어 유형·시즌만 거른다 —
 * 대회별 상대전적은 범위 밖이고, 필요해지면 custom_match 조인으로 건다.
 */
export function metricScopeConditions(
  t: Pick<ScopeColumns, 'gameType' | 'season'>,
  gameTypes: GameType[],
  season?: string | null,
): (SQL | undefined)[] {
  return [gameTypeCondition(t.gameType, gameTypes), season ? eq(t.season, season) : undefined];
}
