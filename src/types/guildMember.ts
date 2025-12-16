import { GuildMember, RiotAccount } from '../database/schema.js';

// --- 검색 및 요청 파라미터 ---

export interface GetGuildMemberQuery {
  riotName: string;
  riotNameTag?: string; 
  limit?: number; 
}

// 부계정 연결 Req
export interface LinkSubAccountRequest {
  guildId: string;
  subRiotName: string;
  subRiotTag: string;
  mainRiotName: string;
  mainRiotTag: string; 
}

// 탈퇴, 복귀 req
export interface UpdateGuildMemberStatusRequest {
  guildId: string;
  riotName: string;
  riotNameTag: string;
  status: string;
}

// --- DB Raw 결과 타입 ---

export type GuildMemberAccount = {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
  isMain: boolean;
  guildId: string;
  createDate: Date;
  updateDate: Date;
  isDeleted: boolean;
};

// --- API 응답 데이터 구조 ---

/**
 * @desc 부계정 목록 조회 API의 단일 항목 데이터 구조
 */
export interface SubAccountSummary {
  guildId: string;
  subRiotName: string;
  subRiotNameTag: string;
  mainRiotName: string | null; 
  mainRiotNameTag: string | null; 
}

// --- 최종 API 응답 인터페이스 ---

export interface GuildMemberResponse {
  status: 'success' | 'error',
  message: string;
  data?: GuildMember | GuildMember[] | null
}

export interface GuildMemberAccountResponse {
  status: 'success' | 'error',
  message: string;
  data?: GuildMemberAccount | GuildMemberAccount[] | null
}

/**
 * @desc 부계정 목록 조회 API의 최종 응답 인터페이스 (HTTP Response)
 */
export interface SubAccountsAPIResponse {
  status: 'success' | 'error',
  message: string;
  data?: SubAccountSummary[] | null;
}