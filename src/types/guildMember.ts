import { GuildMember, RiotAccount } from '../database/schema.js';

export interface GetGuildMemberQuery {
  riotName: string;
  riotNameTag?: string; 
  limit?: number; 
};

export type GuildMemberJoinRiotAccount = {
  guild_member: GuildMember; 
  riot_account: RiotAccount;
};

export interface GuildMemberResponse {
  status: 'success' | 'error',
  message: string;
  data?: GuildMember | GuildMember[] | null
}

export interface GuildMemberWithRiotAccountResponse {
  status: 'success' | 'error',
  message: string;
  data?: GuildMemberJoinRiotAccount | GuildMemberJoinRiotAccount[] | null
}

export interface LinkSubAccountRequest {
  guildId: string;
  subRiotName: string;
  subRiotTag: string;
  mainRiotName: string;
  mainRiotTag: string; 
}
