import { DatePreset } from '../database/datePeriod.js';

/** 1=일반내전 / 2=스크림 / 3=본경기. replay·custom_match·mmr_participant_metric.game_type 공통. */
export type GameType = '1' | '2' | '3';

/**
 * 전적 조회 범위. competitionId가 있거나 gameTypes에 일반내전(1)이 없으면 season·기간 조건은 무시한다 —
 * 대회가 시즌 경계를 넘어도 반 토막 나지 않게. 판정은 ignoresPeriod.
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

/**
 * 시즌·기간 조건을 버려야 하는 범위인가. 대회를 특정했을 때뿐 아니라 대회 유형만 조회할 때도
 * 버린다 — 전적 페이지의 "대회 합산"은 시즌 경계를 넘어 모든 대회를 가로질러 읽는다.
 * 판수 하한·길드 가입 상태 같은 다른 완화는 여전히 isCompetitionScope가 정한다.
 */
export const ignoresPeriod = (scope: MatchScope): boolean =>
  isCompetitionScope(scope) || !scope.gameTypes.includes('1');

/**
 * 경기 목록의 팀 이름 칸. 대회를 특정하지 않은 조회는 여러 대회가 섞여 어느 대회의 팀인지
 * 말할 수 없으므로 비운다 — 칸 자체는 항상 있어야 화면이 분기하지 않는다.
 */
export const competitionTeamNames = (
  scope: MatchScope,
  names: { teamName: string | null; opponentTeamName: string | null },
): { teamName: string | null; opponentTeamName: string | null } =>
  isCompetitionScope(scope) ? names : { teamName: null, opponentTeamName: null };

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
