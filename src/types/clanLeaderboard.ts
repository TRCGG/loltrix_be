import { DatePreset } from '../database/datePeriod.js';

export type ClanLeaderboardPeriod = {
  datePreset?: DatePreset;
  fromMonth?: string;
  toMonth?: string;
  season?: string;
};

export type ClanLeaderboardOptions = ClanLeaderboardPeriod & { page?: number; limit?: number };
export type ChampionCombinationOptions = ClanLeaderboardOptions & {
  combination: 'ADCSUP' | 'MIDJUG';
};

type RecordStats = { totalCount: number; win: number; lose: number; winRate: number };
export type ChampionCombination = RecordStats & {
  champions: { champName: string; champNameEng: string; position: string }[];
  wilsonScore: number;
  playerPairCount: number;
};
export type ClanDuo = RecordStats & {
  players: { playerCode: string; riotName: string; riotNameTag: string }[];
};
export type ClanActivity = {
  totalMatches: number;
  totalPlayers: number;
  dailyMatches: { date: string; matchCount: number }[];
};
