import { and, eq, sql, desc } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  matchParticipant,
  customMatch,
  riotAccount,
  champion,
  guildMember,
} from '../database/schema.js';

const envLoLSeason = process.env.LOL_SEASON || '2026';
const statsMinGameCount = Number(process.env.STATS_MIN_GAME_COUNT || 20);

export class StatisticsService {
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
   * @desc 유저별 게임 통계 조회
   */
  public async getUserGameStatistics(
    guildId: string,
    year: string | undefined,
    month: string | undefined,
    championName: string | undefined,
    position: string | undefined,
    season: string | undefined,
    sortBy: 'totalCount' | 'winRate' = 'totalCount',
    page = 1,
    limit = 50,
  ) {
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();

    // 날짜 조건
    const dateCondition = and(
      year ? sql`TO_CHAR(${customMatch.createDate}, 'YYYY') = ${year}` : undefined,
      month ? sql`TO_CHAR(${customMatch.createDate}, 'MM') = ${month.padStart(2, '0')}` : undefined,
    );

    const shouldGroupByPosition = !!position;

    // 포지션 조건
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;

    // 챔피언 조건
    const champCondition = championName ? eq(champion.champName, championName) : undefined;

    // 시즌 조건
    let seasonCondition;
    if (season === 'ALL') {
      seasonCondition = undefined;
    } else if (season) {
      seasonCondition = eq(customMatch.season, season);
    } else {
      seasonCondition = eq(customMatch.season, envLoLSeason);
    }

    // 최소게임 조건 (승률)
    const minGameCount = sortBy === 'winRate' ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;

    // 정렬 조건
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

    const totalCount = countResult?.count || 0;

    return { result, totalCount };
  }

  /**
   * @desc 챔피언별 통계 조회
   */
  public async getChampionStatistics(
    guildId: string,
    year: string | undefined,
    month: string | undefined,
    position: string | undefined,
    season: string | undefined,
    sortBy: 'totalCount' | 'winRate' = 'totalCount',
    page = 1,
    limit = 50,
  ) {
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();

    // 날짜조건
    const dateCondition = and(
      year ? sql`TO_CHAR(${customMatch.createDate}, 'YYYY') = ${year}` : undefined,
      month ? sql`TO_CHAR(${customMatch.createDate}, 'MM') = ${month.padStart(2, '0')}` : undefined,
    );

    const shouldGroupByPosition = !!position;

    // 포지션 조건
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;

    // 시즌 조건
    let seasonCondition;
    if (season === 'ALL') {
      seasonCondition = undefined;
    } else if (season) {
      seasonCondition = eq(customMatch.season, season);
    } else {
      seasonCondition = eq(customMatch.season, envLoLSeason);
    }
    // 최소게임 조건 (승률)
    const minGameCount = sortBy === 'winRate' ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;

    // 정렬 조건
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

    const subQueryGroupBy = [
      matchParticipant.championId,
      ...(shouldGroupByPosition ? [matchParticipant.position] : []),
    ];

    const subQuery = db
      .select({
        champId: matchParticipant.championId,
      })
      .from(matchParticipant)
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(guildMember, eq(matchParticipant.playerCode, guildMember.account))
      .where(whereCondition)
      .groupBy(...subQueryGroupBy)
      .having(havingCondition)
      .as('sq');

    const [countResult] = await db.select({ count: sql<number>`count(*)::integer` }).from(subQuery);

    const totalCount = countResult?.count || 0;

    return { result, totalCount };
  }
}

export const statisticsService = new StatisticsService();
