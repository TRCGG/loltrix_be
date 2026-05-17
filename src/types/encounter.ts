// ──────────────────────────────────────────────
// DB 쿼리 raw 결과
// ──────────────────────────────────────────────

export interface EncounterRawGame {
  customMatchId: string;
  createDate: Date;
  timePlayed: number;

  // Player A
  aTeam: string;
  aResult: string; // '승' | '패'
  aPosition: string;
  aChampName: string;
  aChampNameEng: string;
  aKill: number;
  aDeath: number;
  aAssist: number;
  aDamage: number;
  aCs: number; // minionsKilled + neutralMinionsKilled
  aGold: number;
  aVision: number;

  // Player B
  bTeam: string;
  bResult: string;
  bPosition: string;
  bChampName: string;
  bChampNameEng: string;
  bKill: number;
  bDeath: number;
  bAssist: number;
  bDamage: number;
  bCs: number;
  bGold: number;
  bVision: number;
}

// ──────────────────────────────────────────────
// 집계 결과 타입
// ──────────────────────────────────────────────

export interface EncounterPlayer {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
}

/** 아군/적 각 시나리오별 전적 (playerA 기준 승/패) */
export interface EncounterScenario {
  total: number;
  win: number;
  lose: number;
}

export interface EncounterKda {
  avgKill: number;
  avgDeath: number;
  avgAssist: number;
  kda: number;
}

export interface EncounterAvgMetrics {
  avgDamage: number;
  avgCsPerMin: number;
  avgGoldPerMin: number;
  avgVision: number;
}

export interface EncounterChampion {
  champName: string;
  champNameEng: string;
  games: number;
  win: number;
  winRate: number;
}

/** 라인 매트릭스 셀 (적으로 만났을 때만) */
export interface LaneMatrixCell {
  aPosition: string;
  bPosition: string;
  total: number;
  aWin: number;
  aWinRate: number;
}

/** 인사이트 항목 (type별 필수 필드를 discriminated union으로 보장) */
export type EncounterInsight =
  | {
      type: 'bestMatchup' | 'worstMatchup' | 'bestAllyMatchup';
      aChampName: string;
      aChampNameEng: string;
      bChampName: string;
      bChampNameEng: string;
      aWin: number;
      total: number;
      aWinRate: number;
    }
  | {
      type: 'strongestLane' | 'bestAllyLane';
      aPosition: string;
      bPosition: string;
      aWin: number;
      total: number;
      aWinRate: number;
    };

// ──────────────────────────────────────────────
// API 응답 타입
// ──────────────────────────────────────────────

export interface EncounterSummary {
  playerA: EncounterPlayer;
  playerB: EncounterPlayer;
  overall: EncounterScenario;
  asEnemies: EncounterScenario;
  asAllies: EncounterScenario;
  avgGameTimeSec: number;
  kda: {
    playerA: EncounterKda;
    playerB: EncounterKda;
  };
  avgMetrics: {
    playerA: EncounterAvgMetrics;
    playerB: EncounterAvgMetrics;
  };
  topChampions: {
    playerA: EncounterChampion[];
    playerB: EncounterChampion[];
  };
  laneMatrix: LaneMatrixCell[];           // 적으로 만났을 때 포지션 조합
  allyLaneMatrix: LaneMatrixCell[];       // 아군일 때 포지션 조합
  championMatchups: ChampionMatchup[];    // 적으로 만났을 때 챔피언 조합별 통계
  duoPicks: DuoPick[];                    // 아군일 때 자주 가는 챔피언 조합
  insights: EncounterInsight[];
}

/** 경기 기록 탭 단건 */
export interface EncounterGameItem {
  customMatchId: string;
  createDate: Date;
  isAlly: boolean;
  playerAWon: boolean;
  timePlayed: number;
  playerA: {
    position: string;
    champName: string;
    champNameEng: string;
    kill: number;
    death: number;
    assist: number;
  };
  playerB: {
    position: string;
    champName: string;
    champNameEng: string;
    kill: number;
    death: number;
    assist: number;
  };
}

export interface EncounterGamesResult {
  games: EncounterGameItem[];
  totalCount: number;
}

/** 챔피언 매치업 단건 (적으로 만났을 때) */
export interface ChampionMatchup {
  aPosition: string | null; // matchupPosition=ALL이면 null
  aChampName: string;
  aChampNameEng: string;
  bChampName: string;
  bChampNameEng: string;
  total: number;
  win: number;
  lose: number;
  winRate: number;
  myKda: number;
  opponentKda: number;
  kdaDiff: number;
}

/** 자주 가는 듀오 픽 단건 (아군일 때) */
export interface DuoPick {
  aChampName: string;
  aChampNameEng: string;
  bChampName: string;
  bChampNameEng: string;
  total: number;
  win: number;
  lose: number;
  winRate: number;
  duoKda: number;
}

/** 자주 만난 상대 단건 */
export interface FrequentOpponent {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
  totalGames: number;
  asAllies: EncounterScenario;
  asEnemies: EncounterScenario;
}

export interface FrequentOpponentsResult {
  opponents: FrequentOpponent[];
  totalCount: number;
}

// ──────────────────────────────────────────────
// 요청 파라미터 타입
// ──────────────────────────────────────────────

/** summary / games 공통 쿼리 */
export interface EncounterQuery {
  riotName1: string;
  riotNameTag1?: string;
  riotName2: string;
  riotNameTag2?: string;
  season?: string;
}

export interface EncounterGamesQuery extends EncounterQuery {
  scenario?: 'all' | 'enemies' | 'allies';
  page?: string;
  limit?: string;
}

/** 자주 만난 상대 쿼리 */
export interface FrequentOpponentsQuery {
  riotName: string;
  riotNameTag?: string;
  season?: string;
  period?: 'recent' | 'all'; // recent = 최근 2개월, all = 전체 (default: recent)
  sortBy?: 'totalGames' | 'winRate';  // default: totalGames
  page?: string;
  limit?: string;
}

/** riotName 검색 결과가 여러 명일 때 반환하는 후보 단건 */
export interface MemberCandidate {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
}

/** API 응답 공통 규격 */
export interface EncounterResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | MemberCandidate[] | null;
}
