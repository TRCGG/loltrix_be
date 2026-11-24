import { inArray, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { customMatch, guild, matchParticipant } from '../database/schema.js';
import { COMPETITION_GAME_TYPES } from '../types/competition.js';

export type SiteOverview = {
  clanCount: number;
  matchCount: number;
  playerCount: number;
  recentMatchCount: number;
  matchCountByType: { normal: number; competition: number };
};

export class SiteStatisticsService {
  /**
   * @desc 이용현황판용 사이트 전체 집계. 비공개 클랜 경기도 숫자에는 포함합니다.
   */
  public async getOverview(): Promise<SiteOverview> {
    // 길드 삭제는 guild.is_deleted만 세우고 경기는 남기므로 조인으로 거른다.
    const response = await db.execute<SiteOverview>(sql`
      WITH matches AS (
        SELECT ${customMatch.id} AS id,
          ${customMatch.gameType} = '1' AS is_normal,
          ${inArray(customMatch.gameType, [...COMPETITION_GAME_TYPES])} AS is_competition,
          ${customMatch.createDate} AS create_date
        FROM ${customMatch}
        INNER JOIN ${guild} ON ${guild.id} = ${customMatch.guildId} AND ${guild.isDeleted} = false
        WHERE ${customMatch.isDeleted} = false
      )
      SELECT
        (SELECT COUNT(*)::integer FROM ${guild} WHERE ${guild.isDeleted} = false) AS "clanCount",
        COUNT(*)::integer AS "matchCount",
        (SELECT COUNT(DISTINCT ${matchParticipant.playerCode})::integer
          FROM ${matchParticipant}
          INNER JOIN matches ON matches.id = ${matchParticipant.customMatchId}
          WHERE ${matchParticipant.isDeleted} = false) AS "playerCount",
        (COUNT(*) FILTER (WHERE create_date >= NOW() - INTERVAL '30 days'))::integer AS "recentMatchCount",
        jsonb_build_object(
          'normal', (COUNT(*) FILTER (WHERE is_normal))::integer,
          'competition', (COUNT(*) FILTER (WHERE is_competition))::integer
        ) AS "matchCountByType"
      FROM matches
    `);
    return response.rows[0];
  }
}

export const siteStatisticsService = new SiteStatisticsService();
