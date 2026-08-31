import { Guild, Replay } from '../database/schema.js';

export interface ReplayFileRequest {
  fileName: string;
  fileUrl: string;
  gameType?: string;
  /** 스크림·본경기용. 생략 시 길드의 OPEN 대회로 해석된다. */
  competitionId?: number;
  createUser: string;
  guild: Guild;
}

export type ReplaySaveResult = Omit<Replay, 'rawData'> & { competitionName: string | null };

export interface ReplayResponse {
  status: 'success' | 'error';
  message: string;
  data?: ReplaySaveResult | null;
}

export interface WebUploadResult {
  succeeded: Array<{ fileName: string; replayCode: string }>;
  failed: Array<{ fileName: string; reason: string }>;

}

export interface WebUploadResponse {
  status: 'success' | 'error';
  message: string;
  data?: WebUploadResult;
}

export interface ReplayListItem {
  id: number;
  replayCode: string;
  fileName: string;
  gameType: string;
  season: string;
  patchVersion: string | null;
  createUser: string;
  guildId: string;
  createDate: Date;
}

export interface ReplayListResponse {
  status: 'success' | 'error';
  message: string;
  data?: ReplayListItem[] | null;
}

export interface GetReplaysQuery {
  page?: number;
  limit?: number;
}

export type { Replay };
