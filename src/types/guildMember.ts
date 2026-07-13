import { GuildMember } from '../database/schema.js';

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
  status: 'success' | 'error';
  message: string;
  data?: GuildMember | GuildMember[] | null;
}

export interface GuildMemberAccountResponse {
  status: 'success' | 'error';
  message: string;
  data?: GuildMemberAccount | GuildMemberAccount[] | null;
}

/**
 * @desc 부계정 목록 조회 API의 최종 응답 인터페이스 (HTTP Response)
 */
export interface SubAccountsAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: SubAccountSummary[] | null;
}

export interface MemberListItem {
  playerCode: string;
  riotName: string;
  riotNameTag: string;
  status: string;
  createDate: Date;
  updateDate: Date;
}

export interface MemberListAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: MemberListItem[] | null;
}

// --- guildManager 웹 권한 관리 (Discord 멤버 기준) ---

/**
 * @desc 멤버 관리 화면 단일 항목 (Discord 멤버 + 길드 스코프 역할)
 * - displayName = guild 별명 ?? global 별명 ?? discord_id
 */
export interface DiscordMemberRoleItem {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  role: string;
}

export interface DiscordMemberRoleListAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: DiscordMemberRoleItem[] | null;
}

// --- 클랜관리 통합 관리 로그 (역할 변경 + 리플 삭제) ---

export type GuildAuditLogType = 'roleChange' | 'replayDelete';

/**
 * @desc 관리 로그 단일 항목 — 역할 부여/회수(roleChange) 또는 리플 삭제(replayDelete)
 * - roleChange: targetMemberId/fromRole/toRole 채워짐, gameId/source는 null
 * - replayDelete: gameId/source 채워짐, targetMemberId/fromRole/toRole은 null
 * - displayName = guild 별명 ?? global 별명 ?? discord_id ('bot'은 그대로 'bot')
 */
export interface GuildAuditLogItem {
  type: GuildAuditLogType;
  createDate: Date;
  actorMemberId: string;
  actorDisplayName: string;
  targetMemberId: string | null;
  targetDisplayName: string | null;
  fromRole: string | null;
  toRole: string | null;
  gameId: string | null;
  source: string | null;
}

export interface GuildAuditLogListAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: GuildAuditLogItem[] | null;
}

/** 역할 부여/회수 요청 body (상한: userUploader) */
export interface UpdateMemberRoleRequest {
  role: 'userNormal' | 'userUploader';
}

export interface UpdateMemberRoleAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: { memberId: string; guildId: string; role: string; changed: boolean } | null;
}
