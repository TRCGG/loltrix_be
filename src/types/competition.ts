import {
  Competition,
  CompetitionApplication,
  CompetitionTeam,
} from '../database/schema.js';
import { TeamRecordSplit } from '../services/competitionRecord.js';

export type CompetitionStatus = 'OPEN' | 'CLOSED';

/** 대회 + 유형별 활성 경기 수 */
export interface CompetitionSummary extends Competition {
  scrimCount: number;
  mainCount: number;
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
 * name 생략 시 OPEN 대회, 없으면 최근 종료 대회.
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

export interface CompetitionResponse<T> {
  status: 'success' | 'error';
  message: string;
  data: T | null;
}

export type CompetitionApplicationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

/** 신청 목록 항목 — 화면이 PLR 코드 대신 소환사명을 보여줄 수 있게 riot 계정을 붙인다. */
export interface CompetitionApplicationItem extends CompetitionApplication {
  riotName: string;
  riotNameTag: string;
}

export interface CompetitionApplyInput {
  playerCode: string;
  title: string;
  availableTime?: string;
  captainAvailable?: string;
  position?: string;
  subPosition?: string;
  comment?: string;
}

export interface CompetitionRosterMember {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
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
  blue: CompetitionRosterMember[];
  red: CompetitionRosterMember[];
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
