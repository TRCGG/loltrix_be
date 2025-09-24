import { Guild, InsertGuild } from '../database/schema.js';

export interface CreateGuildRequest {
  guildId: string;
  guildName: string;
  languageCode?: string; 
}

export interface UpdateGuildRequest {
  guildName?: string;
  languageCode?: string;
  isDeleted?: boolean; 
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
