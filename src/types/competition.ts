import {
  Competition,
  CompetitionApplication,
  CompetitionTeam,
} from '../database/schema.js';
import { TeamRecordSplit } from '../services/competitionRecord.js';

export type CompetitionStatus = 'RECRUITING' | 'IN_PROGRESS' | 'CLOSED';

/** 통계·경기 조회의 포지션 코드와 같은 값 — 신청·로스터가 그 필터에 그대로 걸리게 맞춘다. */
export const COMPETITION_POSITIONS = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;
export type CompetitionPosition = (typeof COMPETITION_POSITIONS)[number];

export const PRACTICE_LEVELS = ['NONE', 'RARE', 'MODERATE', 'OFTEN', 'ACTIVE'] as const;
export type PracticeLevel = (typeof PRACTICE_LEVELS)[number];

export const MAX_APPLICATION_CHAMPIONS = 3;

/** 개설 시 고를 수 있는 상태 — 종료된 대회를 새로 만들 일은 없다. */
export type CompetitionInitialStatus = Extract<CompetitionStatus, 'RECRUITING' | 'IN_PROGRESS'>;

/** 대회 + 유형별 활성 경기 수 + 신청·팀 규모 */
export interface CompetitionSummary extends Competition {
  scrimCount: number;
  mainCount: number;
  applicationCount: number;
  pendingCount: number;
  teamCount: number;
  participantCount: number;
}

export interface CompetitionMatchItem {
  gameId: string;
  gameType: string;
  createDate: Date;
}

export interface CompetitionDetail extends CompetitionSummary {
  matches: CompetitionMatchItem[];
}

/**
 * 대회명 해석 결과. match가 있으면 확정, 없고 candidates가 여럿이면 사용자에게 고르게 한다.
 * name 생략 시 진행중 대회, 없으면 최근 종료 대회.
 */
export interface CompetitionResolveResult {
  match: CompetitionSummary | null;
  /** 최대 10건 */
  candidates: CompetitionSummary[];
  /** 부분일치가 10건을 넘어 잘렸으면 true — 더 정확한 이름을 요구할 근거 */
  truncated: boolean;
}

/** 개설/종료/삭제 주체 — 감사 로그용. 봇은 명령 사용자 Discord id를 body로 전달한다. */
export interface CompetitionActor {
  memberId: string;
  source: 'web' | 'bot';
}

export interface CompetitionCreateInput {
  name: string;
  status?: CompetitionInitialStatus;
  approvalRequired?: boolean;
}

export interface CompetitionUpdateInput {
  name?: string;
  approvalRequired?: boolean;
}

export interface CompetitionResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | null;
}

export type CompetitionApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface CompetitionApplicationChampion {
  id: string;
  champName: string;
  champNameEng: string;
}

/** 신청 목록 항목 — 화면이 PLR 코드·챔피언 id 대신 이름을 보여줄 수 있게 붙인다. */
export interface CompetitionApplicationItem extends Omit<CompetitionApplication, 'champions'> {
  riotName: string;
  riotNameTag: string;
  champions: CompetitionApplicationChampion[];
}

export interface CompetitionApplyInput {
  playerCode: string;
  mainPosition: CompetitionPosition;
  subPositions?: CompetitionPosition[];
  champions?: string[];
  availableTime?: string | null;
  captainAvailable: boolean;
  practiceLevel: PracticeLevel;
  comment?: string | null;
}

/** 본인 신청 수정 — 전부 선택이지만 최소 하나는 있어야 한다(라우트에서 검사). */
export interface CompetitionApplicationUpdateInput {
  playerCode?: string;
  mainPosition?: CompetitionPosition;
  subPositions?: CompetitionPosition[];
  champions?: string[];
  availableTime?: string | null;
  captainAvailable?: boolean;
  practiceLevel?: PracticeLevel;
  comment?: string | null;
}

export interface CompetitionPlayerSummary {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
}

export interface CompetitionRosterMember extends CompetitionPlayerSummary {
  position: CompetitionPosition;
}

export interface RosterSaveTeamInput {
  id?: number;
  name: string;
  captainPlayerCode?: string | null;
  members: { playerCode: string; position: CompetitionPosition }[];
}

/** 로스터 전체 저장 — payload에 없는 팀은 삭제된다. */
export interface RosterSaveInput {
  teams: RosterSaveTeamInput[];
}

export interface CompetitionTeamWithRoster extends CompetitionTeam {
  roster: CompetitionRosterMember[];
}

export interface CompetitionTeamUpdateInput {
  name?: string;
  captainPlayerCode?: string | null;
}

/** 팀 귀속 관점의 경기 항목. blueTeamId/redTeamId가 모두 null이면 아직 귀속되지 않은 경기다. */
export interface CompetitionMatchTeamItem {
  customMatchId: string;
  gameType: string;
  date: Date;
  blueTeamId: number | null;
  redTeamId: number | null;
  blue: CompetitionPlayerSummary[];
  red: CompetitionPlayerSummary[];
}

export interface CompetitionTeamRecordItem extends TeamRecordSplit {
  teamId: number;
  name: string;
}

export interface CompetitionHeadToHeadResult extends TeamRecordSplit {
  matches: {
    customMatchId: string;
    gameType: string;
    date: Date;
    winnerTeamId: number | null;
  }[];
}
