import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  matchParticipant,
  customMatch,
  riotAccount,
  champion,
  guildMember,
} from '../database/schema.js';
import { systemConfigService } from './systemConfig.service.js';
import { StatisticsDatePreset, StatisticsServiceOptions } from '../types/statistics.js';

export class StatisticsService {
  /**
   * @desc 통계 조회에 공통으로 사용하는 집계 SQL 조각을 생성
   */
  private getStatSqlChunks() {
    return {
      totalCount: sql<number>`COUNT(*)::integer`,
      win: sql<number>`COUNT(CASE WHEN ${matchParticipant.gameResult} = '승' THEN 1 END)::integer`,
      lose: sql<number>`COUNT(CASE WHEN ${matchParticipant.gameResult} = '패' THEN 1 END)::integer`,
      winRate: sql<number>`
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE ROUND(
            (COUNT(CASE WHEN ${matchParticipant.gameResult} = '승' THEN 1 END)::numeric * 100.0) / NULLIF(COUNT(*), 0),
            2
          )
        END`,
      kda: sql<number>`
        CASE
          WHEN COALESCE(SUM(${matchParticipant.death}), 0) = 0 THEN 9999
          ELSE ROUND(
            (COALESCE(SUM(${matchParticipant.kill}), 0) + COALESCE(SUM(${matchParticipant.assist}), 0))::numeric
            / NULLIF(COALESCE(SUM(${matchParticipant.death}), 0), 0),
            2
          )
        END`,
    };
  }

  /**
   * @desc 조회 방식에 따라 최근 1개월, 시즌 전체, 월 범위용 날짜 조건을 생성
   */
  private buildDateCondition(
    datePreset: StatisticsDatePreset | undefined,
    fromMonth: string | undefined,
    toMonth: string | undefined,
  ) {
    if (datePreset === 'season') {
      return undefined;
    }

    if (datePreset === 'range') {
      if (!fromMonth || !toMonth) {
        return sql`${customMatch.createDate} >= NOW() - INTERVAL '1 month'`;
      }

      const fromMonthNumber = Number(fromMonth);
      const toMonthNumber = Number(toMonth);
      const monthExpr = sql<number>`EXTRACT(MONTH FROM ${customMatch.createDate})::integer`;

      if (fromMonthNumber <= toMonthNumber) {
        return and(gte(monthExpr, fromMonthNumber), sql`${monthExpr} <= ${toMonthNumber}`);
      }

      return or(gte(monthExpr, fromMonthNumber), sql`${monthExpr} <= ${toMonthNumber}`);
    }

    return sql`${customMatch.createDate} >= NOW() - INTERVAL '1 month'`;
  }

  /**
   * @desc 시즌 필터 값 또는 기본 시즌 설정을 바탕으로 시즌 조건을 생성
   */
  private async buildSeasonCondition(season: string | undefined) {
    const defaultSeason = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');

    if (season) {
      return eq(customMatch.season, season);
    }

    return eq(customMatch.season, defaultSeason);
  }

  /**
   * @desc 유저별 게임 통계 조회
   */
  public async getUserGameStatistics(guildId: string, options: StatisticsServiceOptions) {
    const {
      datePreset,
      fromMonth,
      toMonth,
      championName,
      position,
      season,
      sortBy = 'totalCount',
      page = 1,
      limit = 50,
    } = options;
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();

    const dateCondition = this.buildDateCondition(datePreset, fromMonth, toMonth);
    const shouldGroupByPosition = !!position;
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;
    const champCondition = championName ? eq(champion.champName, championName) : undefined;
    const seasonCondition = await this.buildSeasonCondition(season);

    const statsMinGameCount = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const minGameCount = sortBy === 'winRate' ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;
    const orderCriteria =
      sortBy === 'winRate' ? desc(statColumns.winRate) : desc(statColumns.totalCount);

    const whereCondition = and(
      eq(guildMember.guildId, guildId),
      eq(customMatch.guildId, guildId),
      eq(guildMember.isDeleted, false),
      eq(guildMember.isMain, true),
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      dateCondition,
      champCondition,
      positionCondition,
      seasonCondition,
    );

    const groupByColumns = [
      riotAccount.playerCode,
      riotAccount.riotName,
      riotAccount.riotNameTag,
      ...(shouldGroupByPosition ? [matchParticipant.position] : []),
    ];

    const result = await db
      .select({
        playerCode: riotAccount.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        ...(shouldGroupByPosition ? { position: matchParticipant.position } : {}),
        ...statColumns,
      })
      .from(matchParticipant)
      .innerJoin(riotAccount, eq(matchParticipant.playerCode, riotAccount.playerCode))
      .innerJoin(guildMember, eq(riotAccount.playerCode, guildMember.account))
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .where(whereCondition)
      .groupBy(...groupByColumns)
      .having(havingCondition)
      .orderBy(orderCriteria)
      .limit(limit)
      .offset(offset);

    const subQuery = db
      .select({
        code: riotAccount.playerCode,
      })
      .from(matchParticipant)
      .innerJoin(riotAccount, eq(matchParticipant.playerCode, riotAccount.playerCode))
      .innerJoin(guildMember, eq(riotAccount.playerCode, guildMember.account))
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .where(whereCondition)
      .groupBy(...groupByColumns)
      .having(havingCondition)
      .as('sq');

    const [countResult] = await db.select({ count: sql<number>`count(*)::integer` }).from(subQuery);

    return { result, totalCount: countResult?.count || 0 };
  }

  /**
   * @desc 챔피언별 통계 조회
   */
  public async getChampionStatistics(guildId: string, options: StatisticsServiceOptions) {
    const {
      datePreset,
      fromMonth,
      toMonth,
      position,
      season,
      sortBy = 'totalCount',
      page = 1,
      limit = 50,
    } = options;
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();

    const dateCondition = this.buildDateCondition(datePreset, fromMonth, toMonth);
    const shouldGroupByPosition = !!position;
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;
    const seasonCondition = await this.buildSeasonCondition(season);

    const statsMinGameCount = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const minGameCount = sortBy === 'winRate' ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;
    const orderCriteria =
      sortBy === 'winRate' ? desc(statColumns.winRate) : desc(statColumns.totalCount);

    const whereCondition = and(
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      eq(guildMember.isMain, true),
      eq(guildMember.isDeleted, false),
      eq(guildMember.guildId, guildId),
      eq(customMatch.guildId, guildId),
      dateCondition,
      positionCondition,
      seasonCondition,
    );

    const groupByColumns = [
      champion.champName,
      champion.champNameEng,
      ...(shouldGroupByPosition ? [matchParticipant.position] : []),
    ];

    const result = await db
      .select({
        champName: champion.champName,
        champNameEng: champion.champNameEng,
        ...(shouldGroupByPosition ? { position: matchParticipant.position } : {}),
        ...statColumns,
      })
      .from(matchParticipant)
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(guildMember, eq(matchParticipant.playerCode, guildMember.account))
      .where(whereCondition)
      .groupBy(...groupByColumns)
      .having(havingCondition)
      .orderBy(orderCriteria)
      .limit(limit)
      .offset(offset);

    const subQuery = db
      .select({
        champId: matchParticipant.championId,
      })
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(guildMember, eq(matchParticipant.playerCode, guildMember.account))
      .where(whereCondition)
      .groupBy(
        matchParticipant.championId,
        ...(shouldGroupByPosition ? [matchParticipant.position] : []),
      )
      .having(havingCondition)
      .as('sq');

    const [countResult] = await db.select({ count: sql<number>`count(*)::integer` }).from(subQuery);

    return { result, totalCount: countResult?.count || 0 };
  }
}

export const statisticsService = new StatisticsService();
