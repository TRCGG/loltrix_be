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

export interface WebUploadResult {
  succeeded: Array<{ fileName: string; replayCode: string }>;
  failed: Array<{ fileName: string; reason: string }>;

}

export interface WebUploadResponse {
  status: 'success' | 'error';
  message: string;
  data?: WebUploadResult;
}

export type { Replay };
