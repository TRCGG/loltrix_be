// types/matchParticipant.ts
import { CustomMatch } from '../database/schema.js';
import { DatePreset } from '../database/datePeriod.js';

/** 승률 및 KDA 기본 통계 */
export interface MatchStats {
  totalCount: number;
  win: number;
  lose: number;
  winRate: number;
  kda: number;
}

export interface MultipleMember {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
}

export type Member = {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
  isMain: boolean;
  guildId: string;
  createDate: Date;
  updateDate: Date;
  isDeleted: boolean;
};

/** 최근 한 달 요약 (상단) */
export interface MatchSummary extends MatchStats {
  avgDpm: number;
}

/** 라인별 전적 */
export interface LineStat extends MatchStats {
  position: string | null;
}

/** 모스트 픽 (좌측 리스트) */
export interface MostPick extends MatchStats {
  champName: string | null;
  champNameEng: string | null;
}

/** 게임 상세 정보 (한 경기 내의 플레이어 정보) */
export type GameDetail = Omit<RecentGame, 'teamName' | 'opponentTeamName'>;

export interface SynergyTeammate extends MatchStats {
  riotName: string;
  riotNameTag: string;
}

/** 최근 게임 상세 정보 (메인 리스트) */
export interface RecentGame {
  // Game Info
  gameId: string;
  season: string;
  createDate: Date;
  /** 1=일반내전/2=스크림/3=본경기 */
  gameType?: string;
  competitionId?: number | null;
  competitionName?: string | null;
  gameResult: string;
  gameTeam: string;

  // Player Info
  riotName: string;
  riotNameTag: string;

  // Champion Info
  champName: string;
  champNameEng: string;
  position: string;
  level: number;

  // KDA & Combat
  kill: number;
  death: number;
  assist: number;
  pentaKills: number | null;
  totalDamageChampions: number;
  totalDamageTaken: number;

  // Vision
  visionScore: number;
  visionBought: number;

  // Items
  item0: number;
  item1: number;
  item2: number;
  item3: number;
  item4: number;
  item5: number;
  item6: number;

  // Spells
  summonerSpell1Key: string | null;
  summonerSpell1Name: string | null;
  summonerSpell2Key: string | null;
  summonerSpell2Name: string | null;

  // Runes
  keystoneIcon: string | null;
  keystoneName: string | null;
  substyleIcon: string | null;
  substyleName: string | null;

  /** 대회 범위(competitionId 지정) 조회에서만 값이 찬다 — 그 밖에서는 null. */
  teamName: string | null;
  opponentTeamName: string | null;
}

/** 대시보드 통합 데이터 */
export interface DashboardData {
  member: Member;
  summary: MatchSummary;
  lines: LineStat[];
  mostPicks: MostPick[];
  synergy: SynergyTeammate[];
}

// --- Requests & Responses ---

export interface MatchQuery {
  riotNameTag?: string;
  season?: string;
  position?: string;
  datePreset?: DatePreset;
  fromMonth?: string;
  toMonth?: string;
  page?: string;
  limit?: string;
  /** '1' | '2' | '3' 또는 콤마 구분(예: '2,3'). 생략 시 일반내전(competitionId 있으면 2,3). */
  gameType?: string;
  competitionId?: number;
}

/** API 응답 공통 규격 */
export interface MatchResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | MultipleMember[] | null;
}

/** lines는 mostPicks와 같은 시즌·모집단으로 집계돼야 한다 (프론트가 라인 비중 % 분모로 쓴다) */
export interface MostPicksData {
  mostPicks: MostPick[];
  lines: LineStat[];
}

export type MostPicksResponse = MatchResponse<MostPicksData>;

export type { CustomMatch };
