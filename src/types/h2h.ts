// ──────────────────────────────────────────────
// 자주 만난 상대 (GET /h2h/frequent)
// ──────────────────────────────────────────────

/** 자주 만난 상대 단건 (응답) */
export interface FrequentH2hItem {
  puuid: string; // 본계정 대표 puuid
  riotName: string;
  riotNameTag: string;
  mainLane: string; // 맞붙은 게임 기준 최빈 position
  matchups: number; // 맞붙은 게임 수 (정렬 기준, DESC)
  winRate: number; // 그 상대와 맞붙었을 때 내 승률(%)
  lastPlayedDate: Date;
}

/** 자주 만난 상대 쿼리 (기준 유저는 riotName/riotNameTag로 입력 — 기존 닉네임 검색 방식) */
export interface FrequentH2hQuery {
  riotName: string;
  riotNameTag?: string;
  q?: string; // 상대 riotName#tag 부분일치 필터
  season?: string; // 미입력 시 현재 시즌, 'all'이면 전체
  limit?: string;
}

// ──────────────────────────────────────────────
// 상대전적 상세 (GET /h2h) — against 블록
// ──────────────────────────────────────────────

/** me/oppo 공통 프로필 */
export interface H2hProfile {
  puuid: string;
  riotName: string;
  riotNameTag: string;
  mmr: number | null; // 길드 MMR 테이블 미존재 → 항상 null
  mostLane: string | null; // 시즌 내 최빈 position
  seasonWR: number | null; // 시즌 내전 전체 승률(%)
}

/** 평균 지표 7 + 조건부 1 (against.mine / against.oppos) */
export interface H2hMetrics {
  kda: number | null;
  dpm: number | null;
  laneGoldDiff: number | null;
  tdBefore15: number | null;
  turretPlates: number | null;
  expPerMin: number | null;
  deadTimePct: number | null;
  jungleCsEnemy: number | null; // 둘 다 JUG 매치업일 때만, 그 외 null
}

/** 라인 매트릭스 셀 */
export interface LaneCell {
  c: number; // 게임 수
  w: number; // 내 승
}
/** 5×5 라인 매트릭스 (내 라인 × 상대 라인) */
export type LaneMatrix = Record<string, Record<string, LaneCell>>;

/** 시즌 경계 (streak 배열 인덱스) */
export interface SeasonBreak {
  index: number;
  label: string;
}

/** 가장 많이 맞붙은 라인 (against — 동일 라인끼리 최다, laneMatrix 대각선 max) */
export interface LaneTopFaced {
  lane: string; // 내 라인 = 상대 라인
  count: number;
  wins: number; // 내 승
}

/** 챔피언 매치업 단건 */
export interface H2hMatchup {
  myLane: string;
  oppoLane: string;
  myChamp: string; // champ_name_eng
  oppoChamp: string; // champ_name_eng
  count: number;
  wins: number;
  myKda: string; // 이 매치업 평균 KDA "3.8"
  kdaDiff: string; // myKda − 내 시즌 평균 KDA, 부호 포함 "+1.4"
}

/**
 * 인사이트 카드 — 백엔드는 kind(스타일)+type(종류)+raw 수치/영문 챔프 키만 전달.
 * 한국어 문구·조사는 프론트가 type별 템플릿으로 조립 (§3.6, 2026-06-16 개정).
 */
export type H2hInsight =
  | {
      kind: 'best';
      type: 'counterPick';
      myChamp: string;
      oppoChamp: string;
      wins: number;
      losses: number;
      winRate: number;
      kdaDiff: number;
    }
  | {
      kind: 'worst';
      type: 'nemesis';
      myChamp: string;
      oppoChamp: string;
      wins: number;
      losses: number;
      winRate: number;
      kdaDiff: number;
    }
  | {
      kind: 'counter' | 'best';
      type: 'laneVsResult';
      direction: 'laneWinButLose' | 'laneLoseButWin';
      total: number; // 해당 결과 버킷 총 게임 수 (방향 따라 패배 수 또는 승리 수)
      laneCount: number; // 그중 라인 골드 상태가 어긋난 게임 수. 결과어·라인어는 프론트가 direction에서 파생
    }
  | {
      kind: 'info';
      type: 'momentum';
      direction: 'up' | 'down';
      recentN: number;
      recentWins: number;
      recentWinRate: number;
      careerWinRate: number;
    }
  | {
      kind: 'best' | 'worst';
      type: 'streak';
      streakKind: 'win' | 'lose';
      length: number;
      fromDate: Date | null;
      toDate: Date | null;
      currentLength: number;
    };

/**
 * 최근 맞대결 세부(맞라인 게임만) — 한쪽 단일 경기 raw 지표 묶음.
 * NULL은 0으로 내린다 (프론트가 숫자 가정 — toLocaleString 등). 합산도 COALESCE(0) 후.
 */
export interface H2hRecentDetailSide {
  dmg: number;
  taken: number;
  selfMit: number;
  gold: number;
  cs: number;
  vision: number;
  wardsP: number;
  wardsK: number;
  controlW: number;
  ccTime: number;
  kda: number;
  td15: number;
  underTurretTd: number;
  turretTd: number;
  plates: number;
  enemyJungleCs: number;
  objDmg: number;
  epicKills: number; // dragon+baron+herald
  objSteals: number;
  deadPct: number;
  healShield: number; // heal+shield
  missPings: number;
  laneGoldDiff: number;
}

/** 최근 맞대결 단건 */
export interface H2hRecentItem {
  matchId: string;
  playedDate: Date;
  myResult: 'W' | 'L';
  myLane: string;
  oppoLane: string;
  myChamp: string;
  oppoChamp: string;
  myKda: string; // "6/2/14"
  oppoKda: string;
  gameLen: number; // game_duration(초)
  detail?: { mine: H2hRecentDetailSide; oppo: H2hRecentDetailSide };
}

/** 맞붙은(against) 블록 */
export interface H2hAgainst {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  streak: ('W' | 'L')[]; // 시간순(오래된→최신)
  seasonBreaks: SeasonBreak[];
  mine: H2hMetrics;
  oppos: H2hMetrics;
  laneMatrix: LaneMatrix;
  topLane: LaneTopFaced | null; // 가장 많이 맞붙은 동일 라인 (없으면 null)
  matchups: H2hMatchup[];
  insights: H2hInsight[];
  recent: H2hRecentItem[];
  recentTotal: number; // 페이지네이션용 전체 맞대결 수
}

/** 라인 조합 분포 (함께한) */
export interface H2hLaneCombo {
  mine: string; // 내 position
  oppo: string; // 상대 position
  count: number;
  wins: number;
}

/** 자주 가는 듀오 픽 */
export interface H2hDuoChamp {
  mine: string; // champ_name_eng
  oppo: string; // champ_name_eng
  mineLane: string;
  oppoLane: string;
  count: number;
  wins: number;
  myKda: string; // 내 (K+A 합) / (내 D 합, 0이면 1) — 그 듀오 게임들 합산
  mateKda: string; // 함께한 팀원(oppo) (K+A 합) / (팀원 D 합, 0이면 1)
}

/** 함께한(together) 블록 — 지표·매트릭스·인사이트·우위그래프 없음 (§3.10) */
export interface H2hTogether {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  streak: ('W' | 'L')[];
  laneCombos: H2hLaneCombo[];
  topLaneCombo: H2hLaneCombo | null; // 가장 많이 함께한 라인 조합 (= laneCombos[0], 없으면 null)
  duoChamps: H2hDuoChamp[];
  recent: H2hRecentItem[]; // 최근 함께한 8건 (detail 없음)
}

/** 상대전적 상세 응답 */
export interface H2hDetail {
  me: H2hProfile;
  oppo: H2hProfile;
  totalMet: number; // 함께+맞붙은 총 게임 수
  firstMet: Date | null;
  lastMet: Date | null;
  against: H2hAgainst;
  together: H2hTogether;
}

/** 상대전적 상세 쿼리 (두 유저 닉네임 입력) */
export interface H2hDetailQuery {
  riotName1: string;
  riotNameTag1?: string;
  riotName2: string;
  riotNameTag2?: string;
  season?: string; // 미입력 시 현재 시즌, 'all'이면 전체
  recentLimit?: string;
  recentOffset?: string;
}

// ──────────────────────────────────────────────
// 공통 응답 규격
// ──────────────────────────────────────────────

/** riotName 검색 결과가 여러 명일 때 반환하는 후보 단건 */
export interface MemberCandidate {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
}

export interface H2hResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | MemberCandidate[] | null;
}
