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

export interface GetRawData {
  EXP: string;
  SKIN: string;
  TEAM: string;
  ITEM0: string;
  ITEM1: string;
  ITEM2: string;
  ITEM3: string;
  ITEM4: string;
  ITEM5: string;
  ITEM6: string;
  LEVEL: string;
  PERK0?: string;
  PERK1?: string;
  PERK2?: string;
  PERK3?: string;
  PERK4?: string;
  PERK5?: string;
  PUUID: string;
  ASSISTS: string;
  NUM_DEATHS: string;
  GOLD_EARNED: string;
  KEYSTONE_ID: string;
  PENTA_KILLS: string;
  TIME_PLAYED: string;
  VISION_SCORE: string;
  VISION_BOUGHT: string;
  TEAM_POSITION: string;
  MINIONS_KILLED: string;
  PERK_SUB_STYLE: string;
  CHAMPIONS_KILLED: string;
  RIOT_ID_TAG_LINE: string;
  RIOT_ID_GAME_NAME: string;
  SUMMONER_SPELL_1?: string;
  SUMMONER_SPELL_2?: string;
  TIME_CCING_OTHERS: string;
  TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: string;
  TOTAL_DAMAGE_DEALT_TO_BUILDINGS: string;
  TOTAL_DAMAGE_TAKEN: string;
  INDIVIDUAL_POSITION: string;
  NEUTRAL_MINIONS_KILLED: string;
  NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE: string;
  NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE: string;
}

export type { Replay };