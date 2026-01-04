import { RiotAccount } from '../database/schema';

export interface RiotAccountResponse {
  status: 'success' | 'error';
  messsage: string;
  data?: RiotAccount | RiotAccount[] | null;
}

export interface GetRiotAccountsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export type { RiotAccount };
