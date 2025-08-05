import { Player } from '../database/schema.js'

export interface UpdatePlayerRequest {
  riotName?: string;
  riotNameTag?: string;
  deleteYn?: string;
}

export interface PlayerResponse {
  status: 'success' | 'error';
  message: string;
  data?: Player | Player[] | null;
}

export interface GetPlayersQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export type { Player };