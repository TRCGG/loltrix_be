import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import {
  CompetitionApplication,
  CompetitionMatchTeam,
  CompetitionTeam,
  CompetitionTeamMember,
  InsertCompetitionTeam,
  competition,
  competitionApplication,
  competitionMatchTeam,
  competitionTeam,
  competitionTeamMember,
  customMatch,
  guildAuditLog,
  matchParticipant,
  riotAccount,
} from '../database/schema.js';
import { mainAccountMap } from '../database/subAccountLink.js';
import { BusinessError } from '../types/error.js';
import {
  CompetitionActor,
  CompetitionApplicationItem,
  CompetitionApplicationStatus,
  CompetitionApplyInput,
  CompetitionHeadToHeadResult,
  CompetitionMatchTeamItem,
  CompetitionRosterMember,
  CompetitionTeamRecordItem,
  CompetitionTeamUpdateInput,
  CompetitionTeamWithRoster,
} from '../types/competition.js';
import { CompetitionService } from './competition.service.js';
import { COMPETITION_STATUS } from './competitionLifecycle.js';
import { decideMatchTeams, decideSide } from './competitionAssign.js';
import { AssignedMatchRow, foldHeadToHead, foldOpponentRecords } from './competitionRecord.js';

export const MAX_TEAMS_PER_COMPETITION = 20;
export const MAX_ROSTER_SIZE = 6;

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const WIN = '승';

const pgError = (error: unknown): { code?: string; constraint?: string } =>
  ((error as { cause?: { code?: string } })?.cause ?? error ?? {}) as {
    code?: string;
    constraint?: string;
  };

/** 리플 저장 시 자동 배정에 필요한 참가자 정보 (진영 + 실계정 코드). */
export interface AutoAssignParticipant {
  gameTeam: string;
  playerCode: string;
}

export class CompetitionTeamService {
  // ── 신청 ──

  public async apply(
    guildId: string,
    competitionId: number,
    input: CompetitionApplyInput,
    appliedByMemberId: string,
  ): Promise<CompetitionApplication> {
    try {
      return await db.transaction(async (tx) => {
        const target = await this.loadCompetition(tx, guildId, competitionId, 'share');
        this.assertRecruiting(target);
        const playerCode = await this.toMainAccount(guildId, input.playerCode, tx);

        // 자동 승인에는 결정한 사람이 없어 decided_by_member_id를 비운다.
        const autoApproved = !target.approvalRequired;
        const [created] = await tx
          .insert(competitionApplication)
          .values({
            competitionId,
            playerCode,
            appliedByMemberId,
            title: input.title,
            availableTime: input.availableTime,
            captainAvailable: input.captainAvailable,
            position: input.position,
            subPosition: input.subPosition,
            comment: input.comment,
            status: autoApproved ? 'APPROVED' : 'PENDING',
            decidedDate: autoApproved ? new Date() : null,
          })
          .returning();
        return created;
      });
    } catch (error) {
      return this.rethrowWrite(error, {
        uq_competition_application: [
          'already applied to this competition',
          'application-duplicate',
        ],
      });
    }
  }

  public async listApplications(
    guildId: string,
    competitionId: number,
    status?: CompetitionApplicationStatus,
  ): Promise<CompetitionApplicationItem[]> {
    await this.loadCompetition(db, guildId, competitionId);

    const rows = await db
      .select()
      .from(competitionApplication)
      .innerJoin(riotAccount, eq(riotAccount.playerCode, competitionApplication.playerCode))
      .where(
        and(
          eq(competitionApplication.competitionId, competitionId),
          status ? eq(competitionApplication.status, status) : undefined,
        ),
      )
      .orderBy(desc(competitionApplication.createDate), desc(competitionApplication.id));

    return rows.map((row) => ({
      ...row.competition_application,
      riotName: row.riot_account.riotName,
      riotNameTag: row.riot_account.riotNameTag,
    }));
  }

  public async decideApplication(
    guildId: string,
    competitionId: number,
    applicationId: number,
    status: Extract<CompetitionApplicationStatus, 'APPROVED' | 'REJECTED'>,
    actor: CompetitionActor,
  ): Promise<CompetitionApplication> {
    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));

      const [updated] = await tx
        .update(competitionApplication)
        .set({ status, decidedByMemberId: actor.memberId, decidedDate: new Date() })
        .where(
          and(
            eq(competitionApplication.id, applicationId),
            eq(competitionApplication.competitionId, competitionId),
          ),
        )
        .returning();
      if (!updated) {
        throw new BusinessError('application not found', 404, {
          type: 'application-not-found',
          isLoggable: false,
        });
      }

      await tx.insert(guildAuditLog).values({
        guildId,
        eventType: 'applicationDecide',
        actorMemberId: actor.memberId,
        detail: {
          competitionId,
          applicationId: updated.id,
          playerCode: updated.playerCode,
          status,
          source: actor.source,
        },
      });
      return updated;
    });
  }

  // ── 팀 ──

  public async createTeam(
    guildId: string,
    competitionId: number,
    rawName: string,
  ): Promise<CompetitionTeam> {
    const name = CompetitionService.normalizeName(rawName);
    if (!name) {
      throw new BusinessError('team name is required', 400, { isLoggable: false });
    }

    try {
      return await db.transaction(async (tx) => {
        // 상한 검사가 count-then-insert라 동시 생성 두 건이 서로를 못 보고 21팀이 된다.
        this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'update'));

        const [{ teams }] = await tx
          .select({ teams: sql<number>`count(*)::integer` })
          .from(competitionTeam)
          .where(eq(competitionTeam.competitionId, competitionId));
        if (teams >= MAX_TEAMS_PER_COMPETITION) {
          throw new BusinessError(
            `competition allows up to ${MAX_TEAMS_PER_COMPETITION} teams`,
            409,
            {
              type: 'team-limit-exceeded',
              isLoggable: false,
            },
          );
        }

        const [created] = await tx
          .insert(competitionTeam)
          .values({ competitionId, name })
          .returning();
        return created;
      });
    } catch (error) {
      return this.rethrowWrite(error, {
        uq_competition_team_name: ['team name already exists', 'team-name-exists'],
      });
    }
  }

  public async listTeams(
    guildId: string,
    competitionId: number,
  ): Promise<CompetitionTeamWithRoster[]> {
    await this.loadCompetition(db, guildId, competitionId);

    const [teams, members] = await Promise.all([
      db
        .select()
        .from(competitionTeam)
        .where(eq(competitionTeam.competitionId, competitionId))
        .orderBy(competitionTeam.id),
      db
        .select({
          teamId: competitionTeamMember.teamId,
          playerCode: competitionTeamMember.playerCode,
          riotName: riotAccount.riotName,
          riotNameTag: riotAccount.riotNameTag,
        })
        .from(competitionTeamMember)
        .innerJoin(riotAccount, eq(riotAccount.playerCode, competitionTeamMember.playerCode))
        .where(eq(competitionTeamMember.competitionId, competitionId))
        .orderBy(competitionTeamMember.id),
    ]);

    const byTeam = new Map<number, CompetitionRosterMember[]>();
    for (const member of members) {
      const roster = byTeam.get(member.teamId) ?? [];
      roster.push({
        playerCode: member.playerCode,
        riotName: member.riotName,
        riotNameTag: member.riotNameTag,
      });
      byTeam.set(member.teamId, roster);
    }

    return teams.map((team) => ({ ...team, roster: byTeam.get(team.id) ?? [] }));
  }

  public async updateTeam(
    guildId: string,
    competitionId: number,
    teamId: number,
    input: CompetitionTeamUpdateInput,
  ): Promise<CompetitionTeam> {
    try {
      return await db.transaction(async (tx) => {
        this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));
        const team = await this.loadTeam(tx, competitionId, teamId);

        const patch: Partial<InsertCompetitionTeam> = {};
        if (input.name !== undefined) {
          const name = CompetitionService.normalizeName(input.name);
          if (!name) {
            throw new BusinessError('team name is required', 400, { isLoggable: false });
          }
          patch.name = name;
        }
        if (input.captainPlayerCode !== undefined) {
          patch.captainPlayerCode =
            input.captainPlayerCode === null
              ? null
              : await this.resolveCaptain(tx, guildId, teamId, input.captainPlayerCode);
        }
        if (Object.keys(patch).length === 0) return team;

        const [updated] = await tx
          .update(competitionTeam)
          .set(patch)
          .where(eq(competitionTeam.id, teamId))
          .returning();
        return updated;
      });
    } catch (error) {
      return this.rethrowWrite(error, {
        uq_competition_team_name: ['team name already exists', 'team-name-exists'],
      });
    }
  }

  public async removeTeam(
    guildId: string,
    competitionId: number,
    teamId: number,
  ): Promise<CompetitionTeam> {
    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));
      const team = await this.loadTeam(tx, competitionId, teamId);

      const [{ matches }] = await tx
        .select({ matches: sql<number>`count(*)::integer` })
        .from(competitionMatchTeam)
        .innerJoin(customMatch, eq(customMatch.id, competitionMatchTeam.customMatchId))
        .where(and(eq(competitionMatchTeam.teamId, teamId), eq(customMatch.isDeleted, false)));
      if (matches > 0) {
        throw new BusinessError('team has assigned matches', 409, {
          type: 'team-has-matches',
          isLoggable: false,
        });
      }

      // team_id CASCADE는 이 팀 행만 지워 상대 진영 행이 홀로 남는다 — 그 경기는 양쪽이
      // 채워진 적이 없는 것처럼 보이지도, 미배정으로 잡히지도 않는다. 경기 단위로 지운다.
      const affected = await tx
        .select({ customMatchId: competitionMatchTeam.customMatchId })
        .from(competitionMatchTeam)
        .where(eq(competitionMatchTeam.teamId, teamId));
      if (affected.length > 0) {
        await tx.delete(competitionMatchTeam).where(
          inArray(
            competitionMatchTeam.customMatchId,
            affected.map((row) => row.customMatchId),
          ),
        );
      }

      await tx.delete(competitionTeam).where(eq(competitionTeam.id, teamId));
      return team;
    });
  }

  // ── 로스터 ──

  public async addMember(
    guildId: string,
    competitionId: number,
    teamId: number,
    rawPlayerCode: string,
  ): Promise<CompetitionTeamMember> {
    try {
      return await db.transaction(async (tx) => {
        this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));
        // 상한 검사가 count-then-insert라 동시 추가 두 건이 서로를 못 보고 7명이 된다.
        await this.loadTeam(tx, competitionId, teamId, true);

        const playerCode = await this.toMainAccount(guildId, rawPlayerCode, tx);
        const [{ size }] = await tx
          .select({ size: sql<number>`count(*)::integer` })
          .from(competitionTeamMember)
          .where(eq(competitionTeamMember.teamId, teamId));
        if (size >= MAX_ROSTER_SIZE) {
          throw new BusinessError(`team allows up to ${MAX_ROSTER_SIZE} members`, 409, {
            type: 'roster-limit-exceeded',
            isLoggable: false,
          });
        }

        const [created] = await tx
          .insert(competitionTeamMember)
          .values({ competitionId, teamId, playerCode })
          .returning();
        return created;
      });
    } catch (error) {
      return this.rethrowWrite(error, {
        uq_competition_team_member_player: [
          'player already belongs to a team in this competition',
          'roster-duplicate',
        ],
      });
    }
  }

  public async removeMember(
    guildId: string,
    competitionId: number,
    teamId: number,
    rawPlayerCode: string,
  ): Promise<CompetitionTeamMember> {
    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));
      await this.loadTeam(tx, competitionId, teamId);

      const playerCode = await this.toMainAccount(guildId, rawPlayerCode, tx);
      const [removed] = await tx
        .delete(competitionTeamMember)
        .where(
          and(
            eq(competitionTeamMember.competitionId, competitionId),
            eq(competitionTeamMember.teamId, teamId),
            eq(competitionTeamMember.playerCode, playerCode),
          ),
        )
        .returning();
      if (!removed) {
        throw new BusinessError('roster member not found', 404, {
          type: 'roster-member-not-found',
          isLoggable: false,
        });
      }

      await tx
        .update(competitionTeam)
        .set({ captainPlayerCode: null })
        .where(
          and(eq(competitionTeam.id, teamId), eq(competitionTeam.captainPlayerCode, playerCode)),
        );
      return removed;
    });
  }

  // ── 경기 귀속 ──

  public async listMatches(
    guildId: string,
    competitionId: number,
    unassignedOnly: boolean,
  ): Promise<CompetitionMatchTeamItem[]> {
    await this.loadCompetition(db, guildId, competitionId);

    const blueSide = alias(competitionMatchTeam, 'cmt_blue');
    const redSide = alias(competitionMatchTeam, 'cmt_red');
    const rows = await db
      .select({
        customMatchId: customMatch.id,
        gameType: customMatch.gameType,
        date: customMatch.createDate,
        blueTeamId: blueSide.teamId,
        redTeamId: redSide.teamId,
      })
      .from(customMatch)
      .leftJoin(
        blueSide,
        and(eq(blueSide.customMatchId, customMatch.id), eq(blueSide.gameTeam, 'blue')),
      )
      .leftJoin(
        redSide,
        and(eq(redSide.customMatchId, customMatch.id), eq(redSide.gameTeam, 'red')),
      )
      .where(
        and(
          eq(customMatch.competitionId, competitionId),
          eq(customMatch.guildId, guildId),
          eq(customMatch.isDeleted, false),
          unassignedOnly ? and(isNull(blueSide.id), isNull(redSide.id)) : undefined,
        ),
      )
      .orderBy(desc(customMatch.createDate), desc(customMatch.id));

    if (rows.length === 0) return [];

    const participants = await db
      .select({
        customMatchId: matchParticipant.customMatchId,
        gameTeam: matchParticipant.gameTeam,
        playerCode: matchParticipant.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
      })
      .from(matchParticipant)
      .innerJoin(riotAccount, eq(riotAccount.playerCode, matchParticipant.playerCode))
      .where(
        and(
          inArray(
            matchParticipant.customMatchId,
            rows.map((row) => row.customMatchId),
          ),
          eq(matchParticipant.isDeleted, false),
        ),
      );

    const bySide = new Map<string, CompetitionRosterMember[]>();
    for (const p of participants) {
      const key = `${p.customMatchId}:${p.gameTeam}`;
      const list = bySide.get(key) ?? [];
      list.push({ playerCode: p.playerCode, riotName: p.riotName, riotNameTag: p.riotNameTag });
      bySide.set(key, list);
    }

    return rows.map((row) => ({
      ...row,
      blue: bySide.get(`${row.customMatchId}:blue`) ?? [],
      red: bySide.get(`${row.customMatchId}:red`) ?? [],
    }));
  }

  public async assignMatchTeams(
    guildId: string,
    competitionId: number,
    customMatchId: string,
    input: { blue: number | null; red: number | null },
    actor: CompetitionActor,
  ): Promise<CompetitionMatchTeam[]> {
    if (input.blue == null && input.red == null) {
      throw new BusinessError('at least one side must be a team', 400, {
        type: 'match-team-required',
        isLoggable: false,
      });
    }
    if (input.blue != null && input.blue === input.red) {
      throw new BusinessError('both sides cannot be the same team', 400, {
        type: 'match-team-duplicate',
        isLoggable: false,
      });
    }

    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));

      const [match] = await tx
        .select({ id: customMatch.id })
        .from(customMatch)
        .where(
          and(
            eq(customMatch.id, customMatchId),
            eq(customMatch.guildId, guildId),
            eq(customMatch.competitionId, competitionId),
            eq(customMatch.isDeleted, false),
          ),
        )
        .limit(1);
      if (!match) {
        throw new BusinessError('match not found in this competition', 404, {
          type: 'match-not-found',
          isLoggable: false,
        });
      }

      const teamIds = [
        ...new Set([input.blue, input.red].filter((id): id is number => id != null)),
      ];
      const owned = await tx
        .select({ id: competitionTeam.id })
        .from(competitionTeam)
        .where(
          and(
            eq(competitionTeam.competitionId, competitionId),
            inArray(competitionTeam.id, teamIds),
          ),
        );
      if (owned.length !== teamIds.length) {
        throw new BusinessError('team does not belong to this competition', 400, {
          type: 'team-not-in-competition',
          isLoggable: false,
        });
      }

      const previous = await tx
        .select({
          gameTeam: competitionMatchTeam.gameTeam,
          teamId: competitionMatchTeam.teamId,
        })
        .from(competitionMatchTeam)
        .where(eq(competitionMatchTeam.customMatchId, customMatchId));
      const prevTeamId = (gameTeam: string) =>
        previous.find((row) => row.gameTeam === gameTeam)?.teamId ?? null;

      const saved = await tx
        .insert(competitionMatchTeam)
        .values([
          { customMatchId, gameTeam: 'blue', teamId: input.blue },
          { customMatchId, gameTeam: 'red', teamId: input.red },
        ])
        .onConflictDoUpdate({
          target: [competitionMatchTeam.customMatchId, competitionMatchTeam.gameTeam],
          set: { teamId: sql`excluded.team_id` },
        })
        .returning();

      await tx.insert(guildAuditLog).values({
        guildId,
        eventType: 'matchTeamAssign',
        actorMemberId: actor.memberId,
        detail: {
          competitionId,
          customMatchId,
          blueTeamId: input.blue,
          redTeamId: input.red,
          prevBlueTeamId: prevTeamId('blue'),
          prevRedTeamId: prevTeamId('red'),
          source: actor.source,
        },
      });
      return saved;
    });
  }

  /**
   * 리플 저장 트랜잭션 안에서 진영별 로스터 다수결로 팀을 자동 배정한다.
   * savepoint로 감싸 실패해도 리플 저장은 유지된다 — 배정은 나중에 운영진이 수동으로 고칠 수 있다.
   */
  public async tryAutoAssignMatchTeams(
    input: { guildId: string; competitionId: number | null; customMatchId: string },
    participants: AutoAssignParticipant[],
    tx: TransactionType,
  ): Promise<void> {
    const { guildId, competitionId, customMatchId } = input;
    if (competitionId == null || participants.length === 0) return;

    try {
      await tx.transaction(async (sp) => {
        const codes = [...new Set(participants.map((p) => p.playerCode))];
        const mainAccounts = await mainAccountMap(guildId, codes, sp);
        const rosterCodes = [...new Set(mainAccounts.values())];

        const roster = await sp
          .select({
            playerCode: competitionTeamMember.playerCode,
            teamId: competitionTeamMember.teamId,
          })
          .from(competitionTeamMember)
          .where(
            and(
              eq(competitionTeamMember.competitionId, competitionId),
              inArray(competitionTeamMember.playerCode, rosterCodes),
            ),
          );
        if (roster.length === 0) return;

        const teamByPlayer = new Map(roster.map((r) => [r.playerCode, r.teamId]));
        const sideTeamIds = (gameTeam: string) =>
          participants
            .filter((p) => p.gameTeam === gameTeam)
            .map((p) => teamByPlayer.get(mainAccounts.get(p.playerCode) ?? p.playerCode) ?? null);

        const decided = decideMatchTeams(
          decideSide(sideTeamIds('blue')),
          decideSide(sideTeamIds('red')),
        );
        if (!decided) return;

        await sp
          .insert(competitionMatchTeam)
          .values([
            { customMatchId, gameTeam: 'blue', teamId: decided.blueTeamId },
            { customMatchId, gameTeam: 'red', teamId: decided.redTeamId },
          ])
          .onConflictDoNothing();
      });
    } catch (error) {
      console.error('[competition] auto team assign failed', { customMatchId, error });
    }
  }

  // ── 전적 ──

  public async getTeamRecords(
    guildId: string,
    competitionId: number,
    teamId: number,
  ): Promise<CompetitionTeamRecordItem[]> {
    await this.loadCompetition(db, guildId, competitionId);
    await this.loadTeam(db, competitionId, teamId);

    const [rows, teams] = await Promise.all([
      this.loadAssignedMatches(guildId, competitionId),
      db
        .select({ id: competitionTeam.id, name: competitionTeam.name })
        .from(competitionTeam)
        .where(eq(competitionTeam.competitionId, competitionId)),
    ]);

    const names = new Map(teams.map((team) => [team.id, team.name]));
    return [...foldOpponentRecords(rows, teamId).entries()].map(([opponentId, split]) => ({
      teamId: opponentId,
      name: names.get(opponentId) ?? '',
      ...split,
    }));
  }

  public async getHeadToHead(
    guildId: string,
    competitionId: number,
    teamA: number,
    teamB: number,
  ): Promise<CompetitionHeadToHeadResult> {
    if (teamA === teamB) {
      throw new BusinessError('teamA and teamB must differ', 400, {
        type: 'team-same',
        isLoggable: false,
      });
    }
    await this.loadCompetition(db, guildId, competitionId);
    await this.loadTeam(db, competitionId, teamA);
    await this.loadTeam(db, competitionId, teamB);

    const rows = await this.loadAssignedMatches(guildId, competitionId);
    const { record, matches } = foldHeadToHead(rows, teamA, teamB);
    return {
      ...record,
      matches: matches.map((match) => ({
        customMatchId: match.customMatchId,
        gameType: match.gameType,
        date: match.date,
        winnerTeamId: match.winnerTeamId,
      })),
    };
  }

  // ── private ──

  /** 양 진영이 모두 팀에 귀속된 경기만 (용병전은 팀 전적에서 뺀다). */
  private async loadAssignedMatches(
    guildId: string,
    competitionId: number,
  ): Promise<AssignedMatchRow[]> {
    const blueSide = alias(competitionMatchTeam, 'cmt_blue');
    const redSide = alias(competitionMatchTeam, 'cmt_red');
    const rows = (
      await db
        .select({
          customMatchId: customMatch.id,
          gameType: customMatch.gameType,
          date: customMatch.createDate,
          blueTeamId: blueSide.teamId,
          redTeamId: redSide.teamId,
        })
        .from(customMatch)
        .innerJoin(
          blueSide,
          and(eq(blueSide.customMatchId, customMatch.id), eq(blueSide.gameTeam, 'blue')),
        )
        .innerJoin(
          redSide,
          and(eq(redSide.customMatchId, customMatch.id), eq(redSide.gameTeam, 'red')),
        )
        .where(
          and(
            eq(customMatch.competitionId, competitionId),
            eq(customMatch.guildId, guildId),
            eq(customMatch.isDeleted, false),
          ),
        )
        .orderBy(desc(customMatch.createDate))
    ).filter(
      (row): row is typeof row & { blueTeamId: number; redTeamId: number } =>
        row.blueTeamId != null && row.redTeamId != null,
    );
    if (rows.length === 0) return [];

    const winners = await db
      .selectDistinct({
        customMatchId: matchParticipant.customMatchId,
        gameTeam: matchParticipant.gameTeam,
      })
      .from(matchParticipant)
      .where(
        and(
          inArray(
            matchParticipant.customMatchId,
            rows.map((row) => row.customMatchId),
          ),
          eq(matchParticipant.gameResult, WIN),
          eq(matchParticipant.isDeleted, false),
        ),
      );
    const winnerSide = new Map(winners.map((w) => [w.customMatchId, w.gameTeam]));

    return rows.map((row) => {
      const side = winnerSide.get(row.customMatchId);
      const winnerTeamId = side === 'blue' ? row.blueTeamId : side === 'red' ? row.redTeamId : null;
      return { ...row, winnerTeamId };
    });
  }

  /**
   * lock을 주면 트랜잭션이 끝날 때까지 상태 변경이 끼어들지 못한다 — 잠금 없이 읽으면
   * status를 확인한 뒤 insert 하기 전에 대회가 닫혀 종료된 대회에 행이 들어간다.
   * 상태만 붙잡으면 되는 곳은 'share'(서로를 막지 않음), 상한을 count-then-insert로
   * 검사하는 곳은 'update'.
   */
  private async loadCompetition(
    executor: DbOrTx,
    guildId: string,
    competitionId: number,
    lock?: 'update' | 'share',
  ): Promise<{ id: number; status: string; approvalRequired: boolean }> {
    const query = executor
      .select({
        id: competition.id,
        status: competition.status,
        approvalRequired: competition.approvalRequired,
      })
      .from(competition)
      .where(and(eq(competition.id, competitionId), eq(competition.guildId, guildId)))
      .limit(1);
    const [row] = await (lock ? query.for(lock) : query);
    if (!row) {
      throw new BusinessError('competition not found', 404, {
        type: 'competition-not-found',
        isLoggable: false,
      });
    }
    return row;
  }

  private assertWritable(row: { status: string }): void {
    if (row.status === COMPETITION_STATUS.CLOSED) {
      throw new BusinessError('competition is closed', 409, {
        type: 'competition-closed',
        isLoggable: false,
      });
    }
  }

  /** 신청은 모집중에만 받는다 — 진행중 대회는 로스터가 확정된 뒤라 신청이 들어와도 쓸 곳이 없다. */
  private assertRecruiting(row: { status: string }): void {
    if (row.status !== COMPETITION_STATUS.RECRUITING) {
      throw new BusinessError('competition is not recruiting', 409, {
        type: 'competition-not-recruiting',
        isLoggable: false,
      });
    }
  }

  private async loadTeam(
    executor: DbOrTx,
    competitionId: number,
    teamId: number,
    lock = false,
  ): Promise<CompetitionTeam> {
    const query = executor
      .select()
      .from(competitionTeam)
      .where(and(eq(competitionTeam.id, teamId), eq(competitionTeam.competitionId, competitionId)))
      .limit(1);
    const [row] = await (lock ? query.for('update') : query);
    if (!row) {
      throw new BusinessError('team not found', 404, {
        type: 'team-not-found',
        isLoggable: false,
      });
    }
    return row;
  }

  private async resolveCaptain(
    executor: DbOrTx,
    guildId: string,
    teamId: number,
    rawPlayerCode: string,
  ): Promise<string> {
    const playerCode = await this.toMainAccount(guildId, rawPlayerCode, executor);
    const [member] = await executor
      .select({ id: competitionTeamMember.id })
      .from(competitionTeamMember)
      .where(
        and(
          eq(competitionTeamMember.teamId, teamId),
          eq(competitionTeamMember.playerCode, playerCode),
        ),
      )
      .limit(1);
    if (!member) {
      throw new BusinessError('captain must be on the team roster', 400, {
        type: 'captain-not-in-roster',
        isLoggable: false,
      });
    }
    return playerCode;
  }

  /**
   * guild_member.main_account에는 FK가 없어 riot_account에서 사라진 코드가 남아 있을 수 있다.
   * 그대로 저장하면 FK 위반이 'player not found'로 보고돼, 요청한 계정이 아니라 링크가
   * 깨졌다는 사실이 감춰진다.
   */
  private async toMainAccount(
    guildId: string,
    playerCode: string,
    executor: DbOrTx,
  ): Promise<string> {
    const mainAccount = (await mainAccountMap(guildId, [playerCode], executor)).get(playerCode);
    if (!mainAccount || mainAccount === playerCode) return playerCode;

    const [found] = await executor
      .select({ playerCode: riotAccount.playerCode })
      .from(riotAccount)
      .where(eq(riotAccount.playerCode, mainAccount))
      .limit(1);
    if (!found) {
      throw new BusinessError('linked main account no longer exists', 400, {
        type: 'main-account-not-found',
        isLoggable: true,
      });
    }
    return mainAccount;
  }

  /**
   * DB 제약 위반을 API 응답용 에러로 옮긴다. 대회·팀 존재는 같은 트랜잭션에서 이미 확인했으므로
   * 남은 FK 위반은 등록되지 않은 player_code뿐이다.
   */
  private rethrowWrite(
    error: unknown,
    uniqueErrors: Record<string, [message: string, type: string]>,
  ): never {
    const { code, constraint } = pgError(error);
    if (code === PG_UNIQUE_VIOLATION && constraint && uniqueErrors[constraint]) {
      const [message, type] = uniqueErrors[constraint];
      throw new BusinessError(message, 409, { type, isLoggable: false });
    }
    if (code === PG_FOREIGN_KEY_VIOLATION) {
      throw new BusinessError('player not found', 400, {
        type: 'player-not-found',
        isLoggable: false,
      });
    }
    throw error;
  }
}

export const competitionTeamService = new CompetitionTeamService();
