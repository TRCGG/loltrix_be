import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  matchParticipant,
  customMatch,
  riotAccount,
  champion,
  guildMember,
} from '../database/schema.js';
import { subAccountLink } from '../database/subAccountLink.js';
import { competitionStatSql } from '../database/competitionStats.js';
import { scopeConditions } from '../database/matchScope.js';
import { clanLeaderboardPeriodCondition } from '../database/clanLeaderboardPeriod.js';
import { periodCondition } from '../database/datePeriod.js';
import { wilsonScore } from '../database/wilsonScore.js';
import { systemConfigService } from './systemConfig.service.js';
import {
  ChampionStatisticsServiceOptions,
  StatisticsDatePreset,
  StatisticsServiceOptions,
} from '../types/statistics.js';
import { NORMAL_MATCH_SCOPE, ignoresPeriod, isCompetitionScope } from '../types/matchScope.js';

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
      kills: sql<number>`COALESCE(SUM(${matchParticipant.kill}), 0)::integer`,
      // 분당 챔피언 피해량 = 총 피해 / 총 플레이 분. time_played는 초.
      avgDpm: sql<number>`
        CASE
          WHEN COALESCE(SUM(${matchParticipant.timePlayed}), 0) = 0 THEN 0
          ELSE ROUND(
            COALESCE(SUM(${matchParticipant.totalDamageChampions}), 0)::numeric
            / (SUM(${matchParticipant.timePlayed})::numeric / 60),
            0
          )
        END`,
    };
  }

  private buildDateCondition(
    datePreset: StatisticsDatePreset | undefined,
    fromMonth: string | undefined,
    toMonth: string | undefined,
  ) {
    return datePreset === 'recent30'
      ? clanLeaderboardPeriodCondition(customMatch.createDate, datePreset, fromMonth, toMonth)
      : periodCondition(customMatch.createDate, datePreset ?? 'recent', fromMonth, toMonth);
  }

  /**
   * @desc 시즌 필터 값 또는 기본 시즌 설정을 바탕으로 시즌 조건을 생성
   */
  private async buildSeasonCondition(season: string | undefined) {
    const defaultSeason = await systemConfigService.getConfigOrDefault(
      'LOL_SEASON',
      'error_season',
    );

    if (season) {
      return eq(customMatch.season, season);
    }

    return eq(customMatch.season, defaultSeason);
  }

  /**
   * @desc 유저별 게임 통계 조회
   */
  public async getUserGameStatistics(guildId: string, options: StatisticsServiceOptions) {
    if (options.sortBy === 'wilsonScore') {
      return this.getLeaderboardUserStatistics(guildId, options);
    }
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
      scope = NORMAL_MATCH_SCOPE,
    } = options;
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();
    const competitionScope = isCompetitionScope(scope);

    const noPeriod = ignoresPeriod(scope);
    const dateCondition = noPeriod
      ? undefined
      : this.buildDateCondition(datePreset, fromMonth, toMonth);
    const shouldGroupByPosition = !!position;
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;
    const champCondition = championName ? eq(champion.champName, championName) : undefined;
    const seasonCondition = noPeriod ? undefined : await this.buildSeasonCondition(season);

    // 대회는 판수가 적어 최소 판수 조건을 두지 않는다.
    const statsMinGameCount = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const minGameCount = sortBy === 'winRate' && !competitionScope ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;
    const orderCriteria =
      sortBy === 'winRate' ? desc(statColumns.winRate) : desc(statColumns.totalCount);

    // 부캐 전적은 본캐(effective player_code)로 합산 (TRC-243 A안)
    const link = subAccountLink('mp_sub_link', guildId, matchParticipant.playerCode);

    const { competitionId } = scope;
    const competitionStats =
      competitionId != null ? competitionStatSql(guildId, competitionId) : null;

    const whereCondition = and(
      eq(guildMember.guildId, guildId),
      eq(customMatch.guildId, guildId),
      eq(guildMember.isDeleted, false),
      eq(guildMember.isMain, true),
      // 대회 랭킹은 당시 참가자 전원 — 종료 후 탈퇴한 사람이 빠지면 순위가 바뀐다.
      competitionScope ? undefined : eq(guildMember.status, '1'),
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      ...scopeConditions(customMatch, scope),
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

    const baseQuery = db
      .select({
        playerCode: riotAccount.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        ...(shouldGroupByPosition ? { position: matchParticipant.position } : {}),
        ...statColumns,
        ...(competitionStats ? competitionStats.columns : {}),
      })
      .from(matchParticipant)
      .leftJoin(link.table, link.on)
      .innerJoin(riotAccount, eq(riotAccount.playerCode, link.effectivePlayerCode))
      .innerJoin(guildMember, eq(riotAccount.playerCode, guildMember.account))
      .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
      .innerJoin(champion, eq(matchParticipant.championId, champion.id))
      .$dynamic();

    const result = await (competitionStats?.joins ?? [])
      .reduce((query, join) => query.leftJoin(join.table, join.on), baseQuery)
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
      .leftJoin(link.table, link.on)
      .innerJoin(riotAccount, eq(riotAccount.playerCode, link.effectivePlayerCode))
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

  private async getLeaderboardUserStatistics(
    guildId: string,
    options: StatisticsServiceOptions,
  ) {
    const { datePreset, fromMonth, toMonth, championName, season, position, page = 1, limit = 5 } =
      options;
    const stats = this.getStatSqlChunks();
    const score = wilsonScore(stats.win, stats.totalCount);
    const minimum = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const link = subAccountLink('leaderboard_user_sub_link', guildId, matchParticipant.playerCode);
    const whereCondition = and(
      eq(guildMember.guildId, guildId),
      eq(customMatch.guildId, guildId),
      eq(guildMember.isDeleted, false),
      eq(guildMember.isMain, true),
      eq(guildMember.status, '1'),
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      ...scopeConditions(customMatch, NORMAL_MATCH_SCOPE),
      clanLeaderboardPeriodCondition(customMatch.createDate, datePreset, fromMonth, toMonth),
      await this.buildSeasonCondition(season),
      championName ? eq(champion.champName, championName) : undefined,
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined,
    );
    const groups = [riotAccount.playerCode, riotAccount.riotName, riotAccount.riotNameTag];
    const baseQuery = () =>
      db
        .select({
          playerCode: riotAccount.playerCode,
          riotName: riotAccount.riotName,
          riotNameTag: riotAccount.riotNameTag,
          ...stats,
          wilsonScore: score,
        })
        .from(matchParticipant)
        .leftJoin(link.table, link.on)
        .innerJoin(riotAccount, eq(riotAccount.playerCode, link.effectivePlayerCode))
        .innerJoin(guildMember, eq(riotAccount.playerCode, guildMember.account))
        .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
        .innerJoin(champion, eq(matchParticipant.championId, champion.id))
        .where(whereCondition)
        .groupBy(...groups)
        .having(sql`COUNT(*) >= ${minimum}`);
    const result = await baseQuery()
      .orderBy(desc(score), desc(stats.totalCount), asc(riotAccount.playerCode))
      .limit(limit)
      .offset((page - 1) * limit);
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::integer` })
      .from(baseQuery().as('leaderboard_users'));

    return { result, totalCount: countResult?.count ?? 0 };
  }

  /**
   * @desc 챔피언별 통계 조회
   */
  public async getChampionStatistics(guildId: string, options: ChampionStatisticsServiceOptions) {
    if (options.sortBy === 'pickRate' || options.sortBy === 'wilsonScore') {
      return this.getLeaderboardChampionStatistics(guildId, options);
    }
    const {
      datePreset,
      fromMonth,
      toMonth,
      position,
      season,
      sortBy = 'totalCount',
      page = 1,
      limit = 50,
      scope = NORMAL_MATCH_SCOPE,
    } = options;
    const offset = (page - 1) * limit;
    const statColumns = this.getStatSqlChunks();
    const competitionScope = isCompetitionScope(scope);

    const noPeriod = ignoresPeriod(scope);
    const dateCondition = noPeriod
      ? undefined
      : this.buildDateCondition(datePreset, fromMonth, toMonth);
    const shouldGroupByPosition = !!position;
    const positionCondition =
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined;
    const seasonCondition = noPeriod ? undefined : await this.buildSeasonCondition(season);

    const statsMinGameCount = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const minGameCount = sortBy === 'winRate' && !competitionScope ? statsMinGameCount : 0;
    const havingCondition = minGameCount > 0 ? sql`count(*) >= ${minGameCount}` : undefined;
    const orderCriteria =
      sortBy === 'winRate' ? desc(statColumns.winRate) : desc(statColumns.totalCount);

    // 부캐 전적은 본캐(effective player_code) 멤버십 기준으로 집계 (TRC-243 A안)
    const link = subAccountLink('mp_sub_link', guildId, matchParticipant.playerCode);

    const whereCondition = and(
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      eq(guildMember.isMain, true),
      eq(guildMember.isDeleted, false),
      competitionScope ? undefined : eq(guildMember.status, '1'),
      eq(guildMember.guildId, guildId),
      eq(customMatch.guildId, guildId),
      ...scopeConditions(customMatch, scope),
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
      .leftJoin(link.table, link.on)
      .innerJoin(guildMember, eq(guildMember.account, link.effectivePlayerCode))
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
      .leftJoin(link.table, link.on)
      .innerJoin(guildMember, eq(guildMember.account, link.effectivePlayerCode))
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

  // 기존 정렬의 ALL은 포지션별 행을 반환하므로, 전체 포지션을 합산하는 신규 정렬은 별도로 처리한다.
  private async getLeaderboardChampionStatistics(
    guildId: string,
    options: ChampionStatisticsServiceOptions,
  ) {
    const {
      datePreset,
      fromMonth,
      toMonth,
      season,
      position,
      sortBy,
      page = 1,
      limit = 5,
    } = options;
    const stats = this.getStatSqlChunks();
    const matchCondition = and(
      eq(customMatch.guildId, guildId),
      eq(customMatch.isDeleted, false),
      ...scopeConditions(customMatch, NORMAL_MATCH_SCOPE),
      clanLeaderboardPeriodCondition(customMatch.createDate, datePreset, fromMonth, toMonth),
      await this.buildSeasonCondition(season),
    );
    // 픽률은 참가자 수가 아닌 고유 경기 기준이다. 같은 챔피언이 양 팀에 등장해도 한 경기로 센다.
    const matchCount = sql<number>`COUNT(DISTINCT ${matchParticipant.customMatchId})::integer`;
    // 포지션을 선택해도 분모는 기간 내 전체 내전 수로 고정하고, 분자에만 포지션 조건을 적용한다.
    const matchTotal = db
      .select({ count: sql<number>`COUNT(*)::integer` })
      .from(customMatch)
      .where(matchCondition);
    const totalMatches = sql<number>`(${matchTotal})`.mapWith(Number);
    const pickRate =
      sql<number>`COALESCE(ROUND(${matchCount} * 100.0 / NULLIF(${totalMatches}, 0), 2), 0)`.mapWith(
        Number,
      );
    const score = wilsonScore(stats.win, stats.totalCount);
    const minGameCount =
      sortBy === 'wilsonScore'
        ? await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10)
        : 0;
    const havingCondition = minGameCount > 0 ? sql`COUNT(*) >= ${minGameCount}` : undefined;
    const link = subAccountLink(
      'leaderboard_champion_sub_link',
      guildId,
      matchParticipant.playerCode,
    );
    const whereCondition = and(
      matchCondition,
      eq(matchParticipant.isDeleted, false),
      eq(guildMember.guildId, guildId),
      eq(guildMember.isMain, true),
      eq(guildMember.isDeleted, false),
      eq(guildMember.status, '1'),
      position && position !== 'ALL' ? eq(matchParticipant.position, position) : undefined,
    );
    const groups = [champion.id, champion.champName, champion.champNameEng];
    const baseQuery = () =>
      db
        .select({
          champName: champion.champName,
          champNameEng: champion.champNameEng,
          ...(position && position !== 'ALL' ? { position: matchParticipant.position } : {}),
          ...stats,
          matchCount,
          totalMatches,
          pickRate,
          wilsonScore: score,
        })
        .from(matchParticipant)
        .innerJoin(champion, eq(matchParticipant.championId, champion.id))
        .innerJoin(customMatch, eq(matchParticipant.customMatchId, customMatch.id))
        .leftJoin(link.table, link.on)
        .innerJoin(guildMember, eq(guildMember.account, link.effectivePlayerCode))
        .where(whereCondition)
        .groupBy(...groups, ...(position && position !== 'ALL' ? [matchParticipant.position] : []))
        .having(havingCondition);
    const result = await baseQuery()
      .orderBy(
        desc(sortBy === 'pickRate' ? matchCount : score),
        desc(stats.totalCount),
        asc(champion.id),
      )
      .limit(limit)
      .offset((page - 1) * limit);
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)::integer` })
      .from(baseQuery().as('leaderboard_champions'));
    return { result, totalCount: countResult?.count ?? 0 };
  }
}

export const statisticsService = new StatisticsService();
