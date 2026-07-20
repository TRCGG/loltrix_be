import { Role } from './role.js';
import {
  DiscordMember,
  InsertDiscordMember,
  DiscordToken,
  InsertDiscordToken,
  AuthSession,
  InsertAuthSession,
} from '../database/schema.js';

export interface UpdateDiscordTokenRequest {
  accessToken: string;
  acExpiresDate?: Date;
  refreshToken?: string;
  reExpiresDate?: Date;
  scope?: string;
  tokenType?: string;
}

export interface DiscordTokenResponse {
  status: 'success' | 'error';
  message: string;
  data?: DiscordToken | null;
}

// Discord API 원본 응답 타입
export interface DiscordTokenAPI {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: string;
}

// Discord API Guild 응답 타입
export interface DiscordGuildAPI {
  id: string;
  name: string;
  icon: string;
  banner: string;
  nick?: string;
  role: Role;
  /** Discord 권한 비트마스크 — 내부 판정용이라 응답에서는 제외된다 */
  permissions?: string;
}

export type DiscordGuildWithoutRole = Omit<DiscordGuildAPI, 'role'>;

// Discord API Guild 응답 타입
export interface DiscordGuildAPIResponse {
  status: 'success' | 'error';
  message: string;
  data?: DiscordGuildAPI | DiscordGuildAPI[] | null;
}

export type {
  DiscordMember,
  InsertDiscordMember,
  DiscordToken,
  InsertDiscordToken,
  AuthSession,
  InsertAuthSession,
};
