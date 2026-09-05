import { and, eq, SQL, sql } from 'drizzle-orm';
import { customMatch, matchParticipant, mmrParticipantMetric } from './schema.js';
import { CompetitionRankingStats } from '../types/statistics.js';

const TEAM_TOTALS = 'team_totals';

const teamTotal = (column: string): SQL =>
  sql`${sql.identifier(TEAM_TOTALS)}.${sql.identifier(column)}`;

const teamKills = teamTotal('team_kills');
const teamDamage = teamTotal('team_damage');

/**
 * 게임·진영별 팀 합계. 길드원이 아닌 참가자도 분모에 들어가야 하므로 guild_member를 타지 않는다.
 * 참가자는 한 게임에 한 행뿐이라, 이 값을 참가자 행 기준으로 다시 SUM하면 그 사람이 뛴 게임들의
 * 팀 합계가 된다.
 */
const teamTotalsTable = (guildId: string, competitionId: number): SQL => sql`(
    SELECT
      ${matchParticipant.customMatchId} AS ${sql.identifier('custom_match_id')},
      ${matchParticipant.gameTeam} AS ${sql.identifier('game_team')},
      SUM(${matchParticipant.kill}) AS ${sql.identifier('team_kills')},
      SUM(${matchParticipant.totalDamageChampions}) AS ${sql.identifier('team_damage')}
    FROM ${matchParticipant}
    INNER JOIN ${customMatch} ON ${eq(customMatch.id, matchParticipant.customMatchId)}
    WHERE ${and(
      eq(matchParticipant.isDeleted, false),
      eq(customMatch.isDeleted, false),
      eq(customMatch.guildId, guildId),
      eq(customMatch.competitionId, competitionId),
    )}
    GROUP BY ${matchParticipant.customMatchId}, ${matchParticipant.gameTeam}
  ) ${sql.identifier(TEAM_TOTALS)}`;

export interface CompetitionStatSql {
  columns: {
    killParticipation: SQL<number>;
    damageShare: SQL<number>;
    goldPerMin: SQL<number>;
    avgVisionScore: SQL<number>;
    damagePerDeath: SQL<number>;
    deadTimePct: SQL<number>;
    multiKills: {
      double: SQL<number>;
      triple: SQL<number>;
      quadra: SQL<number>;
      penta: SQL<number>;
    };
  };
  joins: { table: SQL; on: SQL }[];
}

/**
 * 대회 랭킹 전용 집계 조각. 조인이 둘 다 SQL 조각이라 drizzle 결과 타입을 건드리지 않으므로
 * $dynamic 쿼리에 그대로 얹을 수 있다.
 */
export function competitionStatSql(guildId: string, competitionId: number): CompetitionStatSql {
  return {
    columns: {
      killParticipation: sql<number>`
        CASE
          WHEN COALESCE(SUM(${teamKills}), 0) = 0 THEN 0
          ELSE ROUND(
            (COALESCE(SUM(${matchParticipant.kill}), 0)
              + COALESCE(SUM(${matchParticipant.assist}), 0))::numeric * 100.0
            / SUM(${teamKills}),
            2
          )
        END`,
      damageShare: sql<number>`
        CASE
          WHEN COALESCE(SUM(${teamDamage}), 0) = 0 THEN 0
          ELSE ROUND(
            COALESCE(SUM(${matchParticipant.totalDamageChampions}), 0)::numeric * 100.0
            / SUM(${teamDamage}),
            2
          )
        END`,
      goldPerMin: sql<number>`
        CASE
          WHEN COALESCE(SUM(${matchParticipant.timePlayed}), 0) = 0 THEN 0
          ELSE ROUND(
            COALESCE(SUM(${matchParticipant.gold}), 0)::numeric
            / (SUM(${matchParticipant.timePlayed})::numeric / 60),
            2
          )
        END`,
      avgVisionScore: sql<number>`ROUND(COALESCE(AVG(${matchParticipant.visionScore}), 0), 2)`,
      damagePerDeath: sql<number>`
        CASE
          WHEN COALESCE(SUM(${matchParticipant.death}), 0) = 0
            THEN ROUND(COALESCE(SUM(${matchParticipant.totalDamageChampions}), 0)::numeric, 2)
          ELSE ROUND(
            COALESCE(SUM(${matchParticipant.totalDamageChampions}), 0)::numeric
            / SUM(${matchParticipant.death}),
            2
          )
        END`,
      // 게임별 비율의 평균이 아니라 합계끼리 나눈다 — 짧은 게임 한 판이 비율을 끌어올리지 않게.
      deadTimePct: sql<number>`
        CASE
          WHEN COALESCE(SUM(${mmrParticipantMetric.gameDuration}), 0) = 0 THEN 0
          ELSE ROUND(
            COALESCE(SUM(${mmrParticipantMetric.timeSpentDead}), 0)::numeric * 100.0
            / SUM(${mmrParticipantMetric.gameDuration}),
            2
          )
        END`,
      multiKills: {
        double: sql<number>`COALESCE(SUM(${mmrParticipantMetric.doubleKills}), 0)::integer`,
        triple: sql<number>`COALESCE(SUM(${mmrParticipantMetric.tripleKills}), 0)::integer`,
        quadra: sql<number>`COALESCE(SUM(${mmrParticipantMetric.quadraKills}), 0)::integer`,
        // 지표 적재 전 경기에도 값이 있는 쪽을 쓴다.
        penta: sql<number>`COALESCE(SUM(${matchParticipant.pentaKills}), 0)::integer`,
      },
    },
    joins: [
      {
        table: teamTotalsTable(guildId, competitionId),
        on: and(
          sql`${teamTotal('custom_match_id')} = ${matchParticipant.customMatchId}`,
          sql`${teamTotal('game_team')} = ${matchParticipant.gameTeam}`,
        ) as SQL,
      },
      {
        // (custom_match_id, player_code)당 한 행이라는 전제가 깨지면 참가자 합계까지 부풀어 오른다.
        table: sql`${mmrParticipantMetric}`,
        on: and(
          eq(mmrParticipantMetric.customMatchId, matchParticipant.customMatchId),
          eq(mmrParticipantMetric.playerCode, matchParticipant.playerCode),
          eq(mmrParticipantMetric.isDeleted, false),
        ) as SQL,
      },
    ],
  };
}

export const EMPTY_COMPETITION_STATS: CompetitionRankingStats = {
  killParticipation: null,
  damageShare: null,
  goldPerMin: null,
  avgVisionScore: null,
  damagePerDeath: null,
  deadTimePct: null,
  multiKills: null,
};
