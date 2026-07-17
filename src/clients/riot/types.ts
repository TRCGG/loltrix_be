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

/** Match-V5 룬 선택 1건. */
export interface MatchV5PerkSelection {
  perk: number;
  var1?: number;
  var2?: number;
  var3?: number;
}

/** Match-V5 룬 스타일(트리) 1건. description: 'primaryStyle' | 'subStyle'. */
export interface MatchV5PerkStyle {
  description?: string;
  /** 트리(스타일) id. subStyle의 이 값이 perk_sub_style로 저장된다. */
  style: number;
  selections: MatchV5PerkSelection[];
}

export interface MatchV5Perks {
  styles: MatchV5PerkStyle[];
  statPerks?: Record<string, number>;
}

/**
 * Match-V5 참가자 DTO. (MVP raw-only — 현재 직접 소비처 없음, 추후 raw→정규화 승격 시 사용)
 * 필요한 필드만 명시하고, 나머지는 index signature로 느슨하게 둔다.
 */
export interface MatchV5Participant {
  puuid: string;
  riotIdGameName?: string;
  riotIdTagline?: string;
  summonerName?: string;
  championId: number;
  championName: string;
  teamId: number;
  teamPosition: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  timeCCingOthers: number;
  champExperience: number;
  timePlayed: number;
  totalDamageDealtToChampions: number;
  damageDealtToBuildings: number;
  totalDamageTaken: number;
  visionScore: number;
  visionWardsBoughtInGame: number;
  champLevel: number;
  pentaKills?: number;
  doubleKills?: number;
  tripleKills?: number;
  quadraKills?: number;
  killingSprees?: number;
  largestKillingSpree?: number;
  damageSelfMitigated?: number;
  wardsPlaced?: number;
  wardsKilled?: number;
  detectorWardsPlaced?: number;
  totalTimeSpentDead?: number;
  longestTimeSpentLiving?: number;
  damageDealtToObjectives?: number;
  dragonKills?: number;
  baronKills?: number;
  turretKills?: number;
  turretTakedowns?: number;
  objectivesStolen?: number;
  inhibitorKills?: number;
  totalHealsOnTeammates?: number;
  totalDamageShieldedOnTeammates?: number;
  totalMinionsKilled?: number;
  neutralMinionsKilled?: number;
  enemyMissingPings?: number;
  retreatPings?: number;
  onMyWayPings?: number;
  commandPings?: number;
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;
  summoner1Id?: number;
  summoner2Id?: number;
  gameEndedInSurrender?: boolean;
  perks?: MatchV5Perks;
  challenges?: Record<string, number>;
  [key: string]: unknown;
}

/** Match-V5 팀 밴 1건. championId -1 = 밴 없음. */
export interface MatchV5Ban {
  championId: number;
  pickTurn: number;
}

/** Match-V5 팀 DTO. */
export interface MatchV5Team {
  teamId: number;
  win: boolean;
  bans: MatchV5Ban[];
}

/** Match-V5 info DTO. 콜백 재검증(§보안)은 tournamentCode를 DB 코드와 대조한다. */
export interface MatchV5Info {
  /** 경기 시작 시각(epoch ms). played_date 원천(단계 5). */
  gameStartTimestamp?: number;
  gameDuration?: number;
  gameId?: number;
  tournamentCode?: string;
  participants: MatchV5Participant[];
  teams: MatchV5Team[];
  [key: string]: unknown;
}

/**
 * Match-V5 매치 DTO.
 * 콜백 재검증(§보안)은 info.tournamentCode를 DB 코드와 대조한다.
 */
export interface MatchV5Dto {
  metadata: {
    dataVersion: string;
    matchId: string;
    participants: string[];
  };
  info: MatchV5Info;
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
