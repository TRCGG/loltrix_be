import { Guild, InsertGuild } from '../database/schema.js';

export interface CreateGuildRequest {
  name: string;
  description?: string;
}

export interface UpdateGuildRequest {
  name?: string;
  description?: string;
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