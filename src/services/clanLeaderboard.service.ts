import { and, eq, sql, SQL } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  customMatch,
  matchParticipant,
  guildMember,
  riotAccount,
  champion,
} from '../database/schema.js';
import { clanLeaderboardPeriodCondition } from '../database/clanLeaderboardPeriod.js';
import { subAccountLink } from '../database/subAccountLink.js';
import { wilsonScore } from '../database/wilsonScore.js';
import { systemConfigService } from './systemConfig.service.js';
import {
  ChampionCombination,
  ChampionCombinationOptions,
  ClanActivity,
  ClanDuo,
  ClanLeaderboardOptions,
  ClanLeaderboardPeriod,
} from '../types/clanLeaderboard.js';

export class ClanLeaderboardService {
  // 경기 수는 멤버의 가입 상태와 무관하게 유지하고, 참여자 집계만 현재 본캐 멤버십을 따른다.
  // 부캐를 본캐로 변환한 participants를 공유해야 듀오와 조합의 고유 쌍 기준도 일치한다.
  private async source(guildId: string, options: ClanLeaderboardPeriod) {
    const season =
      options.season ||
      (await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season'));
    const link = subAccountLink('leaderboard_sub_link', guildId, matchParticipant.playerCode);
    const matchFilter = and(
      eq(customMatch.guildId, guildId),
      eq(customMatch.isDeleted, false),
      eq(customMatch.gameType, '1'),
      eq(customMatch.season, season),
      clanLeaderboardPeriodCondition(
        customMatch.createDate,
        options.datePreset,
        options.fromMonth,
        options.toMonth,
      ),
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
      SELECT DISTINCT ${matchParticipant.customMatchId} AS match_id,
        ${matchParticipant.gameTeam} AS team, ${matchParticipant.gameResult} AS result,
        ${matchParticipant.position} AS position, ${matchParticipant.championId} AS champion_id,
        ${link.effectivePlayerCode} AS player_code,
        ${riotAccount.riotName} AS riot_name, ${riotAccount.riotNameTag} AS riot_name_tag
      FROM ${matchParticipant}
      INNER JOIN scoped_matches ON scoped_matches.match_id = ${matchParticipant.customMatchId}
      LEFT JOIN ${guildMember} AS leaderboard_sub_link ON ${link.on}
      INNER JOIN ${guildMember} ON ${guildMember.account} = ${link.effectivePlayerCode}
      INNER JOIN ${riotAccount} ON ${riotAccount.playerCode} = ${link.effectivePlayerCode}
      WHERE ${participantFilter}
    )`;
  }

  private async page<T>(source: SQL, ranking: SQL, order: SQL, options: ClanLeaderboardOptions) {
    const { page = 1, limit = 5 } = options;
    // 마지막 페이지를 넘겨도 전체 순위 수는 유지하고, JSON 배열에도 SQL 정렬 순서를 보존한다.
    const response = await db.execute<{ result: T[]; totalCount: number }>(sql`
      WITH ${source}, ranking AS (${ranking}), paged AS (
        SELECT *, ROW_NUMBER() OVER (ORDER BY ${order}) AS ordinal
        FROM ranking ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}
      )
      SELECT (SELECT COUNT(*)::integer FROM ranking) AS "totalCount",
        COALESCE((SELECT jsonb_agg(to_jsonb(paged) - 'ordinal' ORDER BY ordinal) FROM paged), '[]'::jsonb) AS result
    `);
    return response.rows[0] ?? { result: [], totalCount: 0 };
  }

  public async getChampionCombinations(guildId: string, options: ChampionCombinationOptions) {
    const source = await this.source(guildId, options);
    const minimum = await systemConfigService.getNumberConfig('STATS_MIN_GAME_COUNT', 10);
    const positions = options.combination === 'ADCSUP' ? ['ADC', 'SUP'] : ['MID', 'JUG'];
    // 같은 조합이 양 팀에 나오면 각각의 승패 표본이므로 경기 ID와 팀을 함께 세어야 한다.
    const count = sql<number>`COUNT(DISTINCT (a.match_id, a.team))`;
    const wins = sql<number>`COUNT(DISTINCT (a.match_id, a.team)) FILTER (WHERE a.result = '승')`;
    const losses = sql<number>`COUNT(DISTINCT (a.match_id, a.team)) FILTER (WHERE a.result = '패')`;
    // 챔피언은 역할 순서를 구분하지만, 사용 플레이어 쌍은 LEAST/GREATEST로 A–B와 B–A를 합친다.
    // 같은 두 사람이 이 조합을 여러 번 사용해도 playerPairCount에는 한 쌍으로 집계한다.
    const ranking = sql`
      SELECT jsonb_build_array(
        jsonb_build_object('champName', c1.champ_name, 'champNameEng', c1.champ_name_eng, 'position', ${positions[0]}::text),
        jsonb_build_object('champName', c2.champ_name, 'champNameEng', c2.champ_name_eng, 'position', ${positions[1]}::text)
      ) AS champions,
      (${count})::integer AS "totalCount", (${wins})::integer AS win, (${losses})::integer AS lose,
      ROUND((${wins})::numeric * 100 / NULLIF(${count}, 0), 2)::float8 AS "winRate",
      ${wilsonScore(wins, count)} AS "wilsonScore",
      COUNT(DISTINCT (LEAST(a.player_code, b.player_code), GREATEST(a.player_code, b.player_code)))::integer AS "playerPairCount"
      FROM participants a INNER JOIN participants b
        ON a.match_id = b.match_id AND a.team = b.team AND a.player_code <> b.player_code
      INNER JOIN ${champion} c1 ON c1.id = a.champion_id
      INNER JOIN ${champion} c2 ON c2.id = b.champion_id
      WHERE a.position = ${positions[0]} AND b.position = ${positions[1]}
      GROUP BY c1.id, c2.id HAVING ${count} >= ${minimum}
    `;
    return this.page<ChampionCombination>(
      source,
      ranking,
      sql`"wilsonScore" DESC, "totalCount" DESC, champions ASC`,
      options,
    );
  }

  public async getDuos(guildId: string, options: ClanLeaderboardOptions = {}) {
    const source = await this.source(guildId, options);
    // 아래 조인의 player_code < 조건은 A–B/B–A 중복과 본캐 합산 후 자기 자신과의 쌍을 제외한다.
    const count = sql<number>`COUNT(DISTINCT a.match_id)`;
    const wins = sql<number>`COUNT(DISTINCT a.match_id) FILTER (WHERE a.result = '승')`;
    const losses = sql<number>`COUNT(DISTINCT a.match_id) FILTER (WHERE a.result = '패')`;
    const ranking = sql`
      SELECT jsonb_build_array(
        jsonb_build_object('playerCode', a.player_code, 'riotName', a.riot_name, 'riotNameTag', a.riot_name_tag),
        jsonb_build_object('playerCode', b.player_code, 'riotName', b.riot_name, 'riotNameTag', b.riot_name_tag)
      ) AS players,
      (${count})::integer AS "totalCount", (${wins})::integer AS win, (${losses})::integer AS lose,
      ROUND((${wins})::numeric * 100 / NULLIF(${count}, 0), 2)::float8 AS "winRate"
      FROM participants a INNER JOIN participants b
        ON a.match_id = b.match_id AND a.team = b.team AND a.player_code < b.player_code
      GROUP BY a.player_code, a.riot_name, a.riot_name_tag, b.player_code, b.riot_name, b.riot_name_tag
    `;
    return this.page<ClanDuo>(source, ranking, sql`"totalCount" DESC, players ASC`, options);
  }

  public async getActivity(
    guildId: string,
    options: ClanLeaderboardPeriod = {},
  ): Promise<ClanActivity> {
    const source = await this.source(guildId, options);
    const response = await db.execute<ClanActivity>(sql`
      WITH ${source}, daily AS (
        SELECT to_char(registered_at, 'YYYY-MM-DD') AS date, COUNT(*)::integer AS "matchCount"
        FROM scoped_matches GROUP BY to_char(registered_at, 'YYYY-MM-DD')
      )
      SELECT (SELECT COUNT(*)::integer FROM scoped_matches) AS "totalMatches",
        (SELECT COUNT(DISTINCT player_code)::integer FROM participants) AS "totalPlayers",
        COALESCE((SELECT jsonb_agg(to_jsonb(daily) ORDER BY date) FROM daily), '[]'::jsonb) AS "dailyMatches"
    `);
    return response.rows[0] ?? { totalMatches: 0, totalPlayers: 0, dailyMatches: [] };
  }
}

export const clanLeaderboardService = new ClanLeaderboardService();
