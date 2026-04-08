import { Team, TeamMember, InsertTeam, InsertTeamMember } from '../database/schema.js';

export interface CreateTeamRequest {
  name: string;
}

export interface UpdateTeamRequest {
  name: string;
}

export interface AddTeamMemberRequest {
  riotName: string;
  riotNameTag: string;
  position?: string;
}

export interface TeamWithMembers extends Team {
  members: TeamMemberWithAccount[];
}

export interface TeamMemberWithAccount extends TeamMember {
  riotName: string;
  riotNameTag: string;
}

export interface TeamListItem extends Team {
  memberCount: number;
}

export interface TeamResponse {
  status: 'success' | 'error';
  message: string;
  data?:
    | Team
    | Team[]
    | TeamWithMembers
    | TeamListItem[]
    | TeamMemberWithAccount
    | TeamMember
    | null;
}

export interface TeamMemberHistoryResponse {
  status: 'success' | 'error';
  message: string;
  data?: TeamMemberWithAccount[] | null;
}

export interface ExcelUploadResult {
  succeeded: Array<{ teamName: string; teamCode: string; memberCount: number }>;
  failed: Array<{ teamName: string; reason: string; details?: string[] }>;
}

export interface ExcelUploadResponse {
  status: 'success' | 'error';
  message: string;
  data?: ExcelUploadResult | null;
}

export interface GetTeamsQuery {
  page?: number;
  limit?: number;
  search?: string;
}

export type { Team, TeamMember, InsertTeam, InsertTeamMember };
