import { eq, and, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { dailyNews, monthlyNews, newsGuildConfig } from '../database/schema.js';
import {
  SaveDailyNewsRequest,
  SaveMonthlyNewsRequest,
  UpdateNewsConfigRequest,
} from '../types/news.js';

export class NewsService {
  // --- 뉴스 설정 ---

  public async findConfig(guildId: string) {
    const result = await db
      .select()
      .from(newsGuildConfig)
      .where(and(eq(newsGuildConfig.guildId, guildId), eq(newsGuildConfig.isDeleted, false)))
      .limit(1);
    return result[0] || null;
  }

  public async upsertConfig(guildId: string, data: UpdateNewsConfigRequest) {
    const result = await db
      .insert(newsGuildConfig)
      .values({
        guildId,
        newsEnabled: data.newsEnabled ?? false,
        mmrEnabled: data.mmrEnabled ?? false,
        channelId: data.channelId,
        tone: data.tone ?? 'funny',
      })
      .onConflictDoUpdate({
        target: newsGuildConfig.guildId,
        set: {
          ...(data.newsEnabled !== undefined && { newsEnabled: data.newsEnabled }),
          ...(data.mmrEnabled !== undefined && { mmrEnabled: data.mmrEnabled }),
          ...(data.channelId !== undefined && { channelId: data.channelId }),
          ...(data.tone !== undefined && { tone: data.tone }),
          updateDate: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  // --- 일일 뉴스 ---

  public async findDailyNews(guildId: string, newsDate: Date) {
    const result = await db
      .select()
      .from(dailyNews)
      .where(
        and(
          eq(dailyNews.guildId, guildId),
          eq(dailyNews.newsDate, newsDate),
          eq(dailyNews.isDeleted, false),
        ),
      )
      .limit(1);
    return result[0] || null;
  }

  public async saveDailyNews(data: SaveDailyNewsRequest) {
    const newsDate = new Date(data.newsDate);
    const result = await db
      .insert(dailyNews)
      .values({
        guildId: data.guildId,
        newsDate,
        title: data.title,
        discordContent: data.discordContent,
        webContent: data.webContent,
        statsJson: data.statsJson,
      })
      .onConflictDoUpdate({
        target: [dailyNews.guildId, dailyNews.newsDate],
        set: {
          title: data.title,
          discordContent: data.discordContent,
          webContent: data.webContent,
          statsJson: data.statsJson,
          updateDate: new Date(),
        },
      })
      .returning();
    return result[0];
  }

  // --- 월간 뉴스 ---

  public async findMonthlyNews(guildId: string, year: number, month: number) {
    const result = await db
      .select()
      .from(monthlyNews)
      .where(
        and(
          eq(monthlyNews.guildId, guildId),
          eq(monthlyNews.year, year),
          eq(monthlyNews.month, month),
          eq(monthlyNews.isDeleted, false),
        ),
      )
      .limit(1);
    return result[0] || null;
  }

  public async saveMonthlyNews(data: SaveMonthlyNewsRequest) {
    const result = await db
      .insert(monthlyNews)
      .values({
        guildId: data.guildId,
        year: data.year,
        month: data.month,
        title: data.title,
        discordContent: data.discordContent,
        webContent: data.webContent,
        statsJson: data.statsJson,
      })
      .onConflictDoUpdate({
        target: [monthlyNews.guildId, monthlyNews.year, monthlyNews.month],
        set: {
          title: data.title,
          discordContent: data.discordContent,
          webContent: data.webContent,
          statsJson: data.statsJson,
          updateDate: new Date(),
        },
      })
      .returning();
    return result[0];
  }
}

export const newsService = new NewsService();
