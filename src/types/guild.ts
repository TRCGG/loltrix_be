import { Guild, InsertGuild } from '../database/schema.js';

export interface CreateGuildRequest {
  guildId: string;
  guildName: string;
  lanId?: string;
}

export interface UpdateGuildRequest {
  guildName?: string;
  lanId?: string;
  deleteYn?: string;
}

export interface GuildResponse {
  status: 'success' | 'error';
  message: string;
  data?: Guild | Guild[] | null;
}

export interface GetGuildsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export type { Guild, InsertGuild };