import { Guild, Replay } from '../database/schema.js';

export interface ReplayFileRequest {
  fileName: string;
  fileUrl: string;
  gameType?: string;
  createUser: string;
  guild: Guild;
}

export interface ReplayResponse {
  status: 'success' | 'error';
  message: string;
  data?: Replay | Replay[] | null;
}

export interface GetReplaysQuery {
  page?: number;
  limit?: number;
  search?: string;
  guildId?: string;
  gameType?: string;
}

export type { Replay };
