import { and, eq, sql, SQL } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  champion,
  customMatch,
  guildMember,
  matchParticipant,
  riotAccount,
} from '../database/schema.js';
import { subAccountLink } from '../database/subAccountLink.js';
import { systemConfigService } from './systemConfig.service.js';
import {
  HighlightCategory,
  Highlights,
  RisingStar,
  WinStreak,
} from '../types/clanLeaderboardMetrics.js';

const highlightCategories: HighlightCategory[] = [
  'kills',
  'assists',
  'championDamage',
  'visionScore',
  'damageTaken',
  'buildingDamage',
];

export class ClanLeaderboardMetricsService {
  /**
   * @desc 지정한 시즌과 최근 30일 또는 60일의 일반내전·현재 본캐 멤버 참가 기록을 집계할 공통 SQL을 생성합니다.
   */
  private async source(guildId: string, season: string | undefined, days: 30 | 60): Promise<SQL> {
    const selectedSeason =
      season || (await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season'));
    const link = subAccountLink('leaderboard_metric_sub_link', guildId, matchParticipant.playerCode);
    const matchFilter = and(
      eq(customMatch.guildId, guildId),
      eq(customMatch.isDeleted, false),
      eq(customMatch.gameType, '1'),
      eq(customMatch.season, selectedSeason),
      sql`${customMatch.createDate} >= NOW() - (${days} * INTERVAL '1 day')`,
      sql`${customMatch.createDate} <= NOW()`,
    );
    const participantFilter = and(
      eq(matchParticipant.isDeleted, false),
      eq(guildMember.guildId, guildId),
      eq(guildMember.isDeleted, false),
      eq(guildMember.isMain, true),
      eq(guildMember.status, '1'),
    );
    return sql`scoped_matches AS (
      SELECT ${customMatch.id} AS match_id, ${customMatch.createDate} AS registered_at
      FROM ${customMatch} WHERE ${matchFilter}
    ), participants AS (
      SELECT ${matchParticipant.id} AS participant_id, scoped_matches.match_id,
        scoped_matches.registered_at, ${link.effectivePlayerCode} AS player_code,
        ${riotAccount.riotName} AS riot_name, ${riotAccount.riotNameTag} AS riot_name_tag,
        ${matchParticipant.gameResult} AS result,
        ${champion.champName} AS champ_name, ${champion.champNameEng} AS champ_name_eng,
        ${matchParticipant.kill} AS kills, ${matchParticipant.assist} AS assists,
        ${matchParticipant.totalDamageChampions} AS champion_damage,
        ${matchParticipant.visionScore} AS vision_score,
        ${matchParticipant.totalDamageTaken} AS damage_taken,
        ${matchParticipant.totalDamageDealtToBuildings} AS building_damage,
        ${matchParticipant.pentaKills} AS penta_kills
      FROM ${matchParticipant}
      INNER JOIN scoped_matches ON scoped_matches.match_id = ${matchParticipant.customMatchId}
      LEFT JOIN ${guildMember} AS leaderboard_metric_sub_link ON ${link.on}
      INNER JOIN ${guildMember} ON ${guildMember.account} = ${link.effectivePlayerCode}
      INNER JOIN ${riotAccount} ON ${riotAccount.playerCode} = ${link.effectivePlayerCode}
      INNER JOIN ${champion} ON ${champion.id} = ${matchParticipant.championId}
      WHERE ${participantFilter}
    )`;
  }

  /**
   * @desc 최근 30일과 직전 30일의 승률 상승폭을 비교해 상위 5명을 조회합니다.
   */
  public async getRisingStars(guildId: string, season?: string): Promise<RisingStar[]> {
    const source = await this.source(guildId, season, 60);
    const result = await db.execute<RisingStar>(sql`
      WITH ${source}, periods AS (
        SELECT player_code, riot_name, riot_name_tag,
          COUNT(*) FILTER (WHERE registered_at >= NOW() - INTERVAL '30 days')::integer AS current_count,
          COUNT(*) FILTER (WHERE registered_at >= NOW() - INTERVAL '30 days' AND result = '승')::integer AS current_win,
          COUNT(*) FILTER (WHERE registered_at < NOW() - INTERVAL '30 days')::integer AS previous_count,
          COUNT(*) FILTER (WHERE registered_at < NOW() - INTERVAL '30 days' AND result = '승')::integer AS previous_win
        FROM participants GROUP BY player_code, riot_name, riot_name_tag
      ), eligible AS (
        SELECT *,
          (current_win::numeric / current_count - previous_win::numeric / previous_count) * 100 AS delta
        FROM periods WHERE current_count >= 10 AND previous_count >= 10
      )
      SELECT player_code AS "playerCode", riot_name AS "riotName", riot_name_tag AS "riotNameTag",
        jsonb_build_object('totalCount', previous_count, 'win', previous_win,
          'winRate', ROUND(previous_win::numeric * 100 / previous_count, 2)::float8) AS previous,
        jsonb_build_object('totalCount', current_count, 'win', current_win,
          'winRate', ROUND(current_win::numeric * 100 / current_count, 2)::float8) AS current,
        ROUND(delta, 2)::float8 AS "improvementPp"
      FROM eligible WHERE delta > 0
      ORDER BY delta DESC, current_count DESC, player_code ASC LIMIT 5
    `);
    return result.rows;
  }

  /**
   * @desc 최근 30일 단일 경기 공동 최고 기록과 펜타킬 기록을 조회합니다.
   */
  public async getHighlights(guildId: string, season?: string): Promise<Highlights> {
    const source = await this.source(guildId, season, 30);
    const response = await db.execute<{
      records: Partial<Record<HighlightCategory, Highlights[HighlightCategory]>>;
      pentakills: Highlights['pentakills'];
    }>(sql`
      WITH ${source}, measurements AS (
        SELECT p.*, metric.category, metric.value
        FROM participants p CROSS JOIN LATERAL (VALUES
          ('kills', p.kills), ('assists', p.assists),
          ('championDamage', p.champion_damage), ('visionScore', p.vision_score),
          ('damageTaken', p.damage_taken), ('buildingDamage', p.building_damage)
        ) AS metric(category, value)
      ), maxima AS (
        SELECT category, MAX(value) AS value FROM measurements GROUP BY category
      ), categories(category) AS (
        VALUES ('kills'), ('assists'), ('championDamage'), ('visionScore'),
          ('damageTaken'), ('buildingDamage')
      ), records AS (
        SELECT categories.category, maxima.value,
        COALESCE(jsonb_agg(jsonb_build_object(
          'playerCode', measurements.player_code, 'riotName', measurements.riot_name,
          'riotNameTag', measurements.riot_name_tag,
          'champion', jsonb_build_object('champName', measurements.champ_name,
            'champNameEng', measurements.champ_name_eng),
          'registeredDate', to_char(measurements.registered_at, 'YYYY-MM-DD'),
          'value', measurements.value
        ) ORDER BY measurements.registered_at DESC, measurements.match_id DESC,
          measurements.participant_id DESC)
          FILTER (WHERE measurements.participant_id IS NOT NULL), '[]'::jsonb) AS entries
      FROM categories LEFT JOIN maxima ON maxima.category = categories.category
      LEFT JOIN measurements ON measurements.category = categories.category
        AND measurements.value = maxima.value
      GROUP BY categories.category, maxima.value
      ), pentakills AS (
        SELECT COUNT(DISTINCT player_code)::integer AS "totalPlayers",
        COALESCE(SUM(penta_kills), 0)::integer AS "totalPentaKills",
        COALESCE(jsonb_agg(jsonb_build_object(
          'playerCode', player_code, 'riotName', riot_name, 'riotNameTag', riot_name_tag,
          'champion', jsonb_build_object('champName', champ_name, 'champNameEng', champ_name_eng),
          'registeredDate', to_char(registered_at, 'YYYY-MM-DD'), 'pentaKills', penta_kills
        ) ORDER BY registered_at DESC, match_id DESC, participant_id DESC)
          FILTER (WHERE participant_id IS NOT NULL), '[]'::jsonb) AS entries
      FROM participants WHERE penta_kills > 0
      )
      SELECT (SELECT jsonb_object_agg(category,
        jsonb_build_object('value', value, 'entries', entries)) FROM records) AS records,
        (SELECT to_jsonb(pentakills) FROM pentakills) AS pentakills
    `);
    const output = {} as Highlights;
    for (const category of highlightCategories) {
      const record = response.rows[0]?.records?.[category];
      output[category] = { value: record?.value ?? null, entries: record?.entries ?? [] };
    }
    output.pentakills = response.rows[0]?.pentakills ?? {
      totalPlayers: 0,
      totalPentaKills: 0,
      entries: [],
    };
    return output;
  }

  /**
   * @desc 최근 30일 등록 경기에서 현재 진행 중인 2연승 이상 상위 5명을 조회합니다.
   */
  public async getWinStreaks(guildId: string, season?: string): Promise<WinStreak[]> {
    const source = await this.source(guildId, season, 30);
    const result = await db.execute<WinStreak>(sql`
      WITH ${source}, ordered AS (
        SELECT *, SUM(CASE WHEN result = '승' THEN 0 ELSE 1 END) OVER (
          PARTITION BY player_code
          ORDER BY registered_at DESC, match_id DESC, participant_id DESC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS losses_seen
        FROM participants
      ), streaks AS (
        SELECT player_code, riot_name, riot_name_tag, COUNT(*)::integer AS streak,
          MAX(registered_at) AS latest_registered_at
        FROM ordered WHERE result = '승' AND losses_seen = 0
        GROUP BY player_code, riot_name, riot_name_tag HAVING COUNT(*) >= 2
      )
      SELECT player_code AS "playerCode", riot_name AS "riotName", riot_name_tag AS "riotNameTag",
        streak, to_char(latest_registered_at, 'YYYY-MM-DD') AS "latestRegisteredDate"
      FROM streaks ORDER BY streak DESC, latest_registered_at DESC, player_code ASC LIMIT 5
    `);
    return result.rows;
  }
}

export const clanLeaderboardMetricsService = new ClanLeaderboardMetricsService();
