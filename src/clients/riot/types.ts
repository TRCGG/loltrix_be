// Riot Tournament(-stub) V5 / Match V5 DTO. MVP에 필요한 최소 필드만 명시한다.

/** provider 등록 파라미터. */
export interface ProviderRegistrationParams {
  /** 플랫폼 리전. 예: 'KR' */
  region: string;
  /** 경기 종료 콜백을 수신할 URL. */
  url: string;
}

/** tournament 등록 파라미터. */
export interface TournamentRegistrationParams {
  name: string;
  /** registerProvider가 반환한 provider id. */
  providerId: number;
}

export type TournamentMapType = 'SUMMONERS_RIFT' | 'HOWLING_ABYSS';
export type TournamentPickType = 'BLIND_PICK' | 'DRAFT_MODE' | 'ALL_RANDOM' | 'TOURNAMENT_DRAFT';
export type TournamentSpectatorType = 'NONE' | 'LOBBYONLY' | 'ALL';

/**
 * 코드 발급 파라미터.
 * count는 query(발급 개수), 나머지는 body(TournamentCodeParameters)로 전송된다.
 */
export interface TournamentCodeParams {
  /** 발급 개수. 기본 1. */
  count?: number;
  mapType: TournamentMapType;
  pickType: TournamentPickType;
  spectatorType: TournamentSpectatorType;
  teamSize: number;
  /** 코드에 임베드되는 메타 문자열(콜백/게임 조회 시 반환됨). */
  metadata?: string;
  /** 참가 허용 puuid 목록(선택). */
  allowedParticipants?: string[];
  enoughPlayers?: boolean;
}

/** games/by-code 응답 1건(폴백 폴링용, 최소 필드). */
export interface TournamentGamesDto {
  gameId?: number;
  metaData?: string;
  shortCode?: string;
  region?: string;
  [key: string]: unknown;
}

/**
 * Match-V5 매치 DTO(최소).
 * info는 어댑터(단계 5)에서 상세 매핑하므로 느슨하게 둔다.
 * 콜백 재검증(§보안)은 info.tournamentCode를 DB 코드와 대조한다.
 */
export interface MatchV5Dto {
  metadata: {
    dataVersion: string;
    matchId: string;
    participants: string[];
  };
  info: {
    tournamentCode?: string;
    [key: string]: unknown;
  };
}

/** Match-V5 타임라인 DTO(최소). 상세 적재는 후순위이므로 느슨하게 둔다. */
export interface MatchTimelineDto {
  metadata: {
    dataVersion: string;
    matchId: string;
    participants: string[];
  };
  info: {
    [key: string]: unknown;
  };
}
