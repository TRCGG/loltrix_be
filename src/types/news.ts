import { DailyNews, MonthlyNews, NewsGuildConfig } from '../database/schema.js';

export interface SaveDailyNewsRequest {
  guildId: string;
  newsDate: string;
  title: string;
  discordContent: string;
  webContent: string;
  statsJson: Record<string, any>;
}

export interface SaveMonthlyNewsRequest {
  guildId: string;
  year: number;
  month: number;
  title: string;
  discordContent: string;
  webContent: string;
  statsJson: Record<string, any>;
}

export interface UpdateNewsConfigRequest {
  newsEnabled?: boolean;
  mmrEnabled?: boolean;
  channelId?: string;
  tone?: string;
}

export interface NewsResponse {
  status: 'success' | 'error';
  message: string;
  data?: DailyNews | MonthlyNews | NewsGuildConfig | DailyNews[] | MonthlyNews[] | null;
}

export type { DailyNews, MonthlyNews, NewsGuildConfig };
