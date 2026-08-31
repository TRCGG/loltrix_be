import { DatePreset } from '../database/datePeriod.js';

/** 1=일반내전 / 2=스크림 / 3=본경기. replay·custom_match·mmr_participant_metric.game_type 공통. */
export type GameType = '1' | '2' | '3';

/**
 * 전적 조회 범위. competitionId가 있으면 season·기간 조건은 무시한다 —
 * 대회가 시즌 경계를 넘어도 반 토막 나지 않게.
 */
export interface MatchScope {
  gameTypes: GameType[];
  competitionId?: number;
  datePreset?: DatePreset;
  fromMonth?: string;
  toMonth?: string;
}

/** 기존 호출의 기본값. 이 값만으로 스크림·본경기가 일반내전 전적에서 빠진다. */
export const NORMAL_MATCH_SCOPE: MatchScope = { gameTypes: ['1'] };

export const isCompetitionScope = (scope: MatchScope): boolean => scope.competitionId != null;

const GAME_TYPES = new Set<string>(['1', '2', '3']);

/**
 * 쿼리 파라미터 → scope.
 * gameType 생략 시: competitionId가 있으면 스크림+본경기(2,3), 없으면 일반내전(1).
 */
export function scopeFromQuery(query: {
  gameType?: string;
  competitionId?: number | string;
}): MatchScope {
  const competitionId =
    query.competitionId === undefined || query.competitionId === ''
      ? undefined
      : Number(query.competitionId);

  const parsed = (query.gameType ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v): v is GameType => GAME_TYPES.has(v));
  const gameTypes: GameType[] =
    parsed.length > 0 ? [...new Set(parsed)] : competitionId != null ? ['2', '3'] : ['1'];

  return competitionId != null ? { gameTypes, competitionId } : { gameTypes };
}
