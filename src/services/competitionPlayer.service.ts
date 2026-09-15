import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  competition,
  competitionApplication,
  competitionTeam,
  competitionTeamMember,
  customMatch,
  guildMember,
  matchParticipant,
} from '../database/schema.js';
import { mainAccountMap } from '../database/subAccountLink.js';
import {
  COMPETITION_GAME_TYPES,
  CompetitionApplicationStatus,
  CompetitionPosition,
  CompetitionStandings,
  CompetitionStatus,
  PlayerCompetitionItem,
} from '../types/competition.js';
import { competitionTeamService } from './competitionTeam.service.js';
import { kdaOf, winRateOf } from './competitionRecord.js';

const WIN = '승';
const RECENT_SIZE = 6;

interface PlayedRow {
  competitionId: number | null;
  customMatchId: string;
  gameResult: string;
  kill: number;
  death: number;
  assist: number;
}

interface PlayerRecord {
  games: number;
  win: number;
  lose: number;
  kill: number;
  death: number;
  assist: number;
  recent: string[];
}

const emptyRecord = (): PlayerRecord => ({
  games: 0,
  win: 0,
  lose: 0,
  kill: 0,
  death: 0,
  assist: 0,
  recent: [],
});

const teamRank = (
  standings: CompetitionStandings | undefined,
  teamId: number | undefined,
): { scrim: number | null; main: number | null } => {
  const rankOf = (rows: { teamId: number; rank: number }[]) =>
    teamId == null ? null : (rows.find((row) => row.teamId === teamId)?.rank ?? null);
  return { scrim: rankOf(standings?.scrim ?? []), main: rankOf(standings?.main ?? []) };
};

export class CompetitionPlayerService {
  /**
   * 한 선수가 얽힌 대회 전부 — 로스터에 올랐거나, 신청했거나, 한 판이라도 뛴 대회.
   * 셋 중 하나만 있어도 목록에 들어간다: 신청만 하고 안 뽑힌 대회도 본인에게는 이력이다.
   */
  public async listCompetitions(
    guildId: string,
    rawPlayerCode: string,
    status?: CompetitionStatus,
  ): Promise<PlayerCompetitionItem[]> {
    const codes = await this.accountCodes(guildId, rawPlayerCode);

    const [rosters, applications, played] = await Promise.all([
      db
        .select({
          competitionId: competitionTeamMember.competitionId,
          teamId: competitionTeamMember.teamId,
          position: competitionTeamMember.position,
          teamName: competitionTeam.name,
          captainPlayerCode: competitionTeam.captainPlayerCode,
        })
        .from(competitionTeamMember)
        .innerJoin(competitionTeam, eq(competitionTeam.id, competitionTeamMember.teamId))
        .innerJoin(
          competition,
          and(
            eq(competition.id, competitionTeamMember.competitionId),
            eq(competition.guildId, guildId),
          ),
        )
        .where(inArray(competitionTeamMember.playerCode, codes)),
      db
        .select({
          competitionId: competitionApplication.competitionId,
          status: competitionApplication.status,
        })
        .from(competitionApplication)
        .innerJoin(
          competition,
          and(
            eq(competition.id, competitionApplication.competitionId),
            eq(competition.guildId, guildId),
          ),
        )
        .where(inArray(competitionApplication.playerCode, codes)),
      db
        .select({
          competitionId: customMatch.competitionId,
          customMatchId: matchParticipant.customMatchId,
          gameResult: matchParticipant.gameResult,
          kill: matchParticipant.kill,
          death: matchParticipant.death,
          assist: matchParticipant.assist,
        })
        .from(matchParticipant)
        .innerJoin(customMatch, eq(customMatch.id, matchParticipant.customMatchId))
        .where(
          and(
            inArray(matchParticipant.playerCode, codes),
            eq(customMatch.guildId, guildId),
            eq(matchParticipant.isDeleted, false),
            eq(customMatch.isDeleted, false),
            isNotNull(customMatch.competitionId),
            inArray(customMatch.gameType, [...COMPETITION_GAME_TYPES]),
          ),
        )
        .orderBy(desc(customMatch.createDate), desc(customMatch.id)),
    ]);

    const ids = [
      ...new Set([
        ...rosters.map((row) => row.competitionId),
        ...applications.map((row) => row.competitionId),
        ...played.map((row) => row.competitionId).filter((id): id is number => id != null),
      ]),
    ];
    if (ids.length === 0) return [];

    const competitions = await db
      .select()
      .from(competition)
      .where(
        and(
          inArray(competition.id, ids),
          eq(competition.guildId, guildId),
          status ? eq(competition.status, status) : undefined,
        ),
      )
      .orderBy(desc(competition.createDate), desc(competition.id));

    const rosterById = new Map(rosters.map((row) => [row.competitionId, row]));
    const applicationById = new Map(applications.map((row) => [row.competitionId, row.status]));
    const recordById = this.foldPlayed(played);
    const standingsById = await competitionTeamService.computeStandingsMany(
      guildId,
      competitions.filter((row) => rosterById.has(row.id)).map((row) => row.id),
    );

    const items: PlayerCompetitionItem[] = [];
    for (const row of competitions) {
      const roster = rosterById.get(row.id);
      const record = recordById.get(row.id) ?? emptyRecord();
      items.push({
        competitionId: row.id,
        name: row.name,
        status: row.status as CompetitionStatus,
        season: row.season,
        createDate: row.createDate,
        closeDate: row.closeDate,
        team: roster
          ? {
              id: roster.teamId,
              name: roster.teamName,
              position: roster.position as CompetitionPosition,
              isCaptain: codes.includes(roster.captainPlayerCode ?? ''),
            }
          : null,
        applicationStatus:
          (applicationById.get(row.id) as CompetitionApplicationStatus | undefined) ?? null,
        record: {
          games: record.games,
          win: record.win,
          lose: record.lose,
          winRate: winRateOf(record.win, record.games),
          kda: kdaOf(record),
        },
        teamRank: teamRank(standingsById.get(row.id), roster?.teamId),
        recent: record.recent,
      });
    }
    return items;
  }

  /** 본계정 + 그 본계정에 링크된 부계정 전부. 전적·신청·로스터를 이 코드 집합으로 한 번에 건다. */
  public async accountCodes(guildId: string, rawPlayerCode: string): Promise<string[]> {
    const mainAccount =
      (await mainAccountMap(guildId, [rawPlayerCode])).get(rawPlayerCode) ?? rawPlayerCode;
    const linked = await db
      .select({ account: guildMember.account })
      .from(guildMember)
      .where(
        and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.mainAccount, mainAccount),
          eq(guildMember.isMain, false),
          eq(guildMember.isDeleted, false),
        ),
      );
    return [...new Set([mainAccount, ...linked.map((row) => row.account)])];
  }

  private foldPlayed(rows: PlayedRow[]): Map<number, PlayerRecord> {
    const byCompetition = new Map<number, PlayerRecord>();
    // 본캐·부캐가 한 경기에 함께 잡히면(데이터 이상) 같은 경기가 두 판으로 세진다
    const counted = new Set<string>();
    for (const row of rows) {
      if (row.competitionId == null) continue;
      if (counted.has(row.customMatchId)) continue;
      counted.add(row.customMatchId);
      const record = byCompetition.get(row.competitionId) ?? emptyRecord();
      record.games += 1;
      if (row.gameResult === WIN) record.win += 1;
      else record.lose += 1;
      record.kill += row.kill;
      record.death += row.death;
      record.assist += row.assist;
      if (record.recent.length < RECENT_SIZE) record.recent.push(row.gameResult);
      byCompetition.set(row.competitionId, record);
    }
    return byCompetition;
  }
}

export const competitionPlayerService = new CompetitionPlayerService();
