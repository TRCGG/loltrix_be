import { SQL, and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import {
  CompetitionApplication,
  CompetitionMatchTeam,
  CompetitionTeam,
  CompetitionTeamMember,
  InsertCompetitionApplication,
  InsertCompetitionTeam,
  InsertCompetitionTeamMember,
  champion,
  competition,
  competitionApplication,
  competitionMatchTeam,
  competitionTeam,
  competitionTeamMember,
  customMatch,
  guildAuditLog,
  matchParticipant,
  mmrParticipantMetric,
  replay,
  riotAccount,
} from '../database/schema.js';
import { mainAccountMap } from '../database/subAccountLink.js';
import { BusinessError } from '../types/error.js';
import {
  COMPETITION_POSITIONS,
  CompetitionActor,
  CompetitionApplicationChampion,
  CompetitionApplicationItem,
  CompetitionApplicationStatus,
  CompetitionApplicationUpdateInput,
  CompetitionApplyInput,
  CompetitionGameType,
  CompetitionHeadToHeadResult,
  CompetitionMatchTeamItem,
  CompetitionPlayerSummary,
  CompetitionPosition,
  CompetitionRosterMember,
  CompetitionTeamRecordItem,
  CompetitionTeamRoster,
  CompetitionTeamUpdateInput,
  CompetitionTeamWithRoster,
  MatchGameTypeChangeResult,
  RosterSaveInput,
  TeamAssignmentResult,
  COMPETITION_STATUS,
  CompetitionStandings,
  SideStats,
  StandingMatchRow,
} from '../types/competition.js';
import { CompetitionService } from './competition.service.js';
import { decideMatchTeams, decideSide } from './competitionAssign.js';
import {
  emptySplit,
  foldHeadToHead,
  foldOpponentRecords,
  foldStandings,
  foldTeamTotals,
} from './competitionRecord.js';

interface AssignedStandingRow extends StandingMatchRow {
  competitionId: number;
}

const groupByCompetition = <T extends { competitionId: number }>(rows: T[]): Map<number, T[]> => {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.competitionId) ?? [];
    list.push(row);
    grouped.set(row.competitionId, list);
  }
  return grouped;
};

export const MAX_TEAMS_PER_COMPETITION = 20;
/** 팀은 포지션당 한 명 — 상한과 포지션 유니크가 같은 규칙의 앞뒤다. */
export const MAX_ROSTER_SIZE = COMPETITION_POSITIONS.length;

const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const WIN = '승';

const POSITION_ORDER = new Map<string, number>(
  COMPETITION_POSITIONS.map((position, index) => [position, index]),
);

const ROSTER_UNIQUE_ERRORS: Record<string, [message: string, type: string]> = {
  uq_competition_team_name: ['team name already exists', 'team-name-exists'],
  uq_competition_team_member_player: [
    'player already belongs to a team in this competition',
    'roster-duplicate',
  ],
  uq_competition_team_member_position: [
    'position is already taken in this team',
    'roster-position-taken',
  ],
};

/** 신청 목록 조인 결과 — drizzle이 테이블명으로 묶어 준 모양 그대로. */
interface ApplicationJoinRow {
  competition_application: CompetitionApplication;
  riot_account: { riotName: string; riotNameTag: string };
}

interface ExistingRosterTeam {
  id: number;
  name: string;
  captainPlayerCode: string | null;
}

interface ResolvedRosterTeam {
  id?: number;
  name: string;
  captainPlayerCode: string | null;
  members: { playerCode: string; position: CompetitionPosition }[];
}

const pgError = (error: unknown): { code?: string; constraint?: string } =>
  ((error as { cause?: { code?: string } })?.cause ?? error ?? {}) as {
    code?: string;
    constraint?: string;
  };

/**
 * 운영진·봇이 아니면 승인된 신청만 보인다 — 남의 PENDING·REJECTED까지 열면 누가 떨어졌는지가
 * 참가자 전원에게 공개된다. 필터를 생략한 요청은 막지 않고 APPROVED로 좁힌다.
 */
export const visibleApplicationStatus = (
  requested: CompetitionApplicationStatus | undefined,
  canSeeAll: boolean,
): CompetitionApplicationStatus | undefined => {
  if (canSeeAll) return requested;
  if (requested && requested !== 'APPROVED') {
    throw new BusinessError('only approved applications are visible', 403, {
      type: 'application-status-forbidden',
      isLoggable: false,
    });
  }
  return 'APPROVED';
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
        // assertRecruiting도 CLOSED를 걸러내지만, 종료는 다른 쓰기 작업과 같은 에러로 알려야 한다.
        this.assertWritable(target);
        this.assertRecruiting(target);
        await this.assertApplicationFields(
          input.mainPosition,
          input.subPositions,
          input.champions,
          tx,
        );
        const playerCode = await this.toMainAccount(guildId, input.playerCode, tx);

        // 자동 승인에는 결정한 사람이 없어 decided_by_member_id를 비운다.
        const autoApproved = !target.approvalRequired;
        const [created] = await tx
          .insert(competitionApplication)
          .values({
            competitionId,
            playerCode,
            appliedByMemberId,
            mainPosition: input.mainPosition,
            subPositions: input.subPositions ?? [],
            champions: input.champions ?? [],
            availableTime: input.availableTime ?? null,
            captainAvailable: input.captainAvailable,
            practiceLevel: input.practiceLevel,
            comment: input.comment ?? null,
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

    const rows = await this.selectApplications(
      and(
        eq(competitionApplication.competitionId, competitionId),
        status ? eq(competitionApplication.status, status) : undefined,
      ),
    );
    return this.attachChampions(rows);
  }

  public async getMyApplication(
    guildId: string,
    competitionId: number,
    memberId: string,
  ): Promise<CompetitionApplicationItem> {
    await this.loadCompetition(db, guildId, competitionId);

    const rows = await this.selectApplications(
      and(
        eq(competitionApplication.competitionId, competitionId),
        eq(competitionApplication.appliedByMemberId, memberId),
      ),
    );
    const [item] = await this.attachChampions(rows);
    if (!item) throw this.applicationNotFound();
    return item;
  }

  public async updateMyApplication(
    guildId: string,
    competitionId: number,
    memberId: string,
    input: CompetitionApplicationUpdateInput,
  ): Promise<CompetitionApplication> {
    try {
      return await db.transaction(async (tx) => {
        const target = await this.loadCompetition(tx, guildId, competitionId, 'share');
        this.assertWritable(target);
        this.assertRecruiting(target);

        const current = await this.loadMyApplication(tx, competitionId, memberId);

        // 주포지션만 바꿔도 남아 있던 부포지션과 겹칠 수 있어, 저장될 조합으로 검사한다.
        await this.assertApplicationFields(
          input.mainPosition ?? current.mainPosition,
          input.subPositions ?? current.subPositions,
          input.champions,
          tx,
        );

        const patch: Partial<InsertCompetitionApplication> = {};
        if (input.playerCode !== undefined) {
          patch.playerCode = await this.toMainAccount(guildId, input.playerCode, tx);
        }
        if (input.mainPosition !== undefined) patch.mainPosition = input.mainPosition;
        if (input.subPositions !== undefined) patch.subPositions = input.subPositions;
        if (input.champions !== undefined) patch.champions = input.champions;
        if (input.availableTime !== undefined) patch.availableTime = input.availableTime;
        if (input.captainAvailable !== undefined) patch.captainAvailable = input.captainAvailable;
        if (input.practiceLevel !== undefined) patch.practiceLevel = input.practiceLevel;
        if (input.comment !== undefined) patch.comment = input.comment;

        const [updated] = await tx
          .update(competitionApplication)
          .set(patch)
          .where(eq(competitionApplication.id, current.id))
          .returning();
        return updated;
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

  /** 조회·수정과 같은 한 건만 지운다 — 계정 둘로 신청했으면 나머지 한 건은 남는다. */
  public async deleteMyApplication(
    guildId: string,
    competitionId: number,
    memberId: string,
  ): Promise<CompetitionApplication> {
    return db.transaction(async (tx) => {
      const target = await this.loadCompetition(tx, guildId, competitionId, 'share');
      this.assertWritable(target);
      this.assertRecruiting(target);

      const current = await this.loadMyApplication(tx, competitionId, memberId);
      const [removed] = await tx
        .delete(competitionApplication)
        .where(eq(competitionApplication.id, current.id))
        .returning();
      if (!removed) throw this.applicationNotFound();
      return removed;
    });
  }

  /** 여러 건을 한 UPDATE로 결정한다 — 하나라도 이 대회 것이 아니면 아무것도 쓰지 않는다. */
  public async decideApplications(
    guildId: string,
    competitionId: number,
    applicationIds: number[],
    status: CompetitionApplicationStatus,
    actor: CompetitionActor,
  ): Promise<CompetitionApplication[]> {
    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));

      // PENDING으로 되돌리면 결정 기록도 지운다 — 남겨두면 판정 전인데 판정자가 찍혀 있다.
      const reset = status === 'PENDING';
      const updated = await tx
        .update(competitionApplication)
        .set({
          status,
          decidedByMemberId: reset ? null : actor.memberId,
          decidedDate: reset ? null : new Date(),
        })
        .where(
          and(
            inArray(competitionApplication.id, applicationIds),
            eq(competitionApplication.competitionId, competitionId),
          ),
        )
        .returning();

      if (updated.length !== applicationIds.length) {
        const found = new Set(updated.map((row) => row.id));
        const missing = applicationIds.filter((id) => !found.has(id));
        throw new BusinessError(`application not found: ${missing.join(', ')}`, 404, {
          type: 'application-not-found',
          isLoggable: false,
        });
      }

      await tx.insert(guildAuditLog).values(
        updated.map((row) => ({
          guildId,
          eventType: 'applicationDecide',
          actorMemberId: actor.memberId,
          detail: {
            competitionId,
            applicationId: row.id,
            playerCode: row.playerCode,
            status,
            source: actor.source,
          },
        })),
      );
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
    const [teams, assigned] = await Promise.all([
      this.teamsWithRoster(db, competitionId),
      this.loadAssignedMatches(guildId, [competitionId]),
    ]);
    const totals = foldTeamTotals(assigned);
    return teams.map((team) => ({ ...team, records: totals.get(team.id) ?? emptySplit() }));
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
      await this.deleteTeams(tx, [teamId]);
      return team;
    });
  }

  // ── 로스터 ──

  public async addMember(
    guildId: string,
    competitionId: number,
    teamId: number,
    input: { playerCode: string; position: CompetitionPosition },
  ): Promise<CompetitionTeamMember> {
    try {
      return await db.transaction(async (tx) => {
        this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));
        // 상한 검사가 count-then-insert라 동시 추가 두 건이 서로를 못 보고 상한을 넘는다.
        await this.loadTeam(tx, competitionId, teamId, true);

        const playerCode = await this.toMainAccount(guildId, input.playerCode, tx);
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
          .values({ competitionId, teamId, playerCode, position: input.position })
          .returning();
        return created;
      });
    } catch (error) {
      return this.rethrowWrite(error, ROSTER_UNIQUE_ERRORS);
    }
  }

  /**
   * 대회의 팀 편성 전체를 한 번에 바꾼다. payload에 없는 팀은 지워지고, 남는 팀은 이름·팀장·로스터가
   * payload와 같아진다. 개별 API를 여러 번 부르면 중간 상태가 유니크 제약에 걸려(포지션·소속) 화면이
   * 순서를 맞춰야 하지만, 여기서는 삭제를 전부 끝낸 뒤 삽입해 그 순서 문제를 없앤다.
   */
  public async saveRoster(
    guildId: string,
    competitionId: number,
    input: RosterSaveInput,
  ): Promise<CompetitionTeamRoster[]> {
    const payload = this.normalizeRosterPayload(input);

    try {
      return await db.transaction(async (tx) => {
        this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'update'));
        const teams = await this.resolveRosterPlayers(guildId, payload, tx);

        const existing = await tx
          .select({
            id: competitionTeam.id,
            name: competitionTeam.name,
            captainPlayerCode: competitionTeam.captainPlayerCode,
          })
          .from(competitionTeam)
          .where(eq(competitionTeam.competitionId, competitionId));
        const existingIds = new Set(existing.map((team) => team.id));
        for (const team of teams) {
          if (team.id !== undefined && !existingIds.has(team.id)) {
            throw new BusinessError(`team not found: ${team.id}`, 404, {
              type: 'team-not-found',
              isLoggable: false,
            });
          }
        }

        const keptIds = new Set(teams.map((team) => team.id).filter((id) => id !== undefined));
        const removedIds = [...existingIds].filter((id) => !keptIds.has(id));
        if (removedIds.length > 0) await this.deleteTeams(tx, removedIds);

        await this.saveRosterMembers(tx, competitionId, teams, existing);
        return this.teamsWithRoster(tx, competitionId);
      });
    } catch (error) {
      return this.rethrowWrite(error, ROSTER_UNIQUE_ERRORS);
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
    const blueTeam = alias(competitionTeam, 'ct_blue');
    const redTeam = alias(competitionTeam, 'ct_red');
    const rows = await db
      .select({
        customMatchId: customMatch.id,
        gameType: customMatch.gameType,
        date: customMatch.createDate,
        blueTeamId: blueSide.teamId,
        redTeamId: redSide.teamId,
        blueTeamName: blueTeam.name,
        redTeamName: redTeam.name,
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
      .leftJoin(blueTeam, eq(blueTeam.id, blueSide.teamId))
      .leftJoin(redTeam, eq(redTeam.id, redSide.teamId))
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
        gameResult: matchParticipant.gameResult,
        timePlayed: matchParticipant.timePlayed,
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

    const bySide = new Map<string, CompetitionPlayerSummary[]>();
    const winnerSide = new Map<string, string | null>();
    const gameLength = new Map<string, number>();
    for (const p of participants) {
      const key = `${p.customMatchId}:${p.gameTeam}`;
      const list = bySide.get(key) ?? [];
      list.push({ playerCode: p.playerCode, riotName: p.riotName, riotNameTag: p.riotNameTag });
      bySide.set(key, list);
      if (p.gameResult === WIN) {
        // 양 진영에 모두 승 행이 있는 손상 데이터는 어느 쪽도 승자로 세지 않는다
        const seen = winnerSide.has(p.customMatchId) ? winnerSide.get(p.customMatchId) : p.gameTeam;
        winnerSide.set(p.customMatchId, seen === p.gameTeam ? p.gameTeam : null);
      }
      // time_played는 참가자별 값이라 어긋날 수 있어, 가장 긴 값을 경기 길이로 삼는다
      gameLength.set(p.customMatchId, Math.max(gameLength.get(p.customMatchId) ?? 0, p.timePlayed));
    }

    return rows.map((row) => {
      const side = winnerSide.get(row.customMatchId);
      return {
        ...row,
        winnerTeamId: side === 'blue' ? row.blueTeamId : side === 'red' ? row.redTeamId : null,
        gameLength: gameLength.get(row.customMatchId) ?? null,
        blue: bySide.get(`${row.customMatchId}:blue`) ?? [],
        red: bySide.get(`${row.customMatchId}:red`) ?? [],
      };
    });
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
  ): Promise<TeamAssignmentResult> {
    const { guildId, competitionId, customMatchId } = input;
    if (competitionId == null || participants.length === 0) return { status: 'unassigned' };

    try {
      return await tx.transaction(async (sp): Promise<TeamAssignmentResult> => {
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
        if (roster.length === 0) return { status: 'unassigned' };

        const teamByPlayer = new Map(roster.map((r) => [r.playerCode, r.teamId]));
        const sideTeamIds = (gameTeam: string) =>
          participants
            .filter((p) => p.gameTeam === gameTeam)
            .map((p) => teamByPlayer.get(mainAccounts.get(p.playerCode) ?? p.playerCode) ?? null);

        const decided = decideMatchTeams(
          decideSide(sideTeamIds('blue')),
          decideSide(sideTeamIds('red')),
        );
        if (!decided) return { status: 'unassigned' };

        await sp
          .insert(competitionMatchTeam)
          .values([
            { customMatchId, gameTeam: 'blue', teamId: decided.blueTeamId },
            { customMatchId, gameTeam: 'red', teamId: decided.redTeamId },
          ])
          .onConflictDoNothing();

        const { blueTeamId, redTeamId } = decided;
        if (blueTeamId != null && redTeamId != null) {
          return { status: 'assigned', blueTeamId, redTeamId };
        }
        if (blueTeamId != null) return { status: 'mercenary', blueTeamId, redTeamId: null };
        if (redTeamId != null) return { status: 'mercenary', blueTeamId: null, redTeamId };
        return { status: 'unassigned' };
      });
    } catch (error) {
      console.error('[competition] auto team assign failed', { customMatchId, error });
      return { status: 'unassigned' };
    }
  }

  /**
   * 대회 경기의 유형(스크림/본경기)을 한 번에 옮긴다. 유형은 custom_match·replay·
   * mmr_participant_metric 세 곳에 복제돼 있어 셋을 같은 트랜잭션에서 함께 바꿔야
   * 전적·MMR 조회가 서로 다른 유형으로 갈린다.
   */
  public async changeMatchGameType(
    guildId: string,
    competitionId: number,
    customMatchIds: string[],
    gameType: CompetitionGameType,
    actor: CompetitionActor,
  ): Promise<MatchGameTypeChangeResult> {
    return db.transaction(async (tx) => {
      this.assertWritable(await this.loadCompetition(tx, guildId, competitionId, 'share'));

      // 삭제(!drop)가 끼어들면 이미 지운 경기의 유형을 바꾸게 되므로 대상 행을 잠근 뒤 검사한다.
      const matches = await tx
        .select({ id: customMatch.id, gameType: customMatch.gameType })
        .from(customMatch)
        .where(
          and(
            inArray(customMatch.id, customMatchIds),
            eq(customMatch.guildId, guildId),
            eq(customMatch.competitionId, competitionId),
            eq(customMatch.isDeleted, false),
          ),
        )
        .for('update');

      const found = new Set(matches.map((match) => match.id));
      const missing = customMatchIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new BusinessError(
          `matches not found in this competition: ${missing.join(', ')}`,
          404,
          {
            type: 'match-not-found',
            isLoggable: false,
          },
        );
      }

      const targets = matches.filter((match) => match.gameType !== gameType);
      const skipped = matches
        .filter((match) => match.gameType === gameType)
        .map((match) => match.id);
      if (targets.length === 0) return { changed: [], skipped };

      const changed = targets.map((match) => match.id);
      await tx.update(customMatch).set({ gameType }).where(inArray(customMatch.id, changed));
      // replay만 $onUpdate가 없어 갱신 시각을 직접 넣는다.
      await tx
        .update(replay)
        .set({ gameType, updateDate: new Date() })
        .where(inArray(replay.replayCode, changed));
      await tx
        .update(mmrParticipantMetric)
        .set({ gameType })
        .where(inArray(mmrParticipantMetric.customMatchId, changed));

      await tx.insert(guildAuditLog).values(
        targets.map((match) => ({
          guildId,
          eventType: 'matchGameTypeChange',
          actorMemberId: actor.memberId,
          detail: {
            competitionId,
            customMatchId: match.id,
            from: match.gameType,
            to: gameType,
            source: actor.source,
          },
        })),
      );

      return { changed, skipped };
    });
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
      this.loadAssignedMatches(guildId, [competitionId]),
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

  /**
   * 대회 순위표. 양 진영이 모두 팀에 귀속된 경기만 세고, 스크림·본경기를 따로 매긴다.
   * 대회의 모든 팀이 0판이어도 목록에 남는다 — 화면이 참가 팀 전체를 보여줘야 한다.
   */
  public async getStandings(guildId: string, competitionId: number): Promise<CompetitionStandings> {
    await this.loadCompetition(db, guildId, competitionId);
    return this.computeStandings(guildId, competitionId);
  }

  /** 대회 존재를 이미 확인한 호출자용. */
  public async computeStandings(
    guildId: string,
    competitionId: number,
  ): Promise<CompetitionStandings> {
    const standings = await this.computeStandingsMany(guildId, [competitionId]);
    return standings.get(competitionId) ?? foldStandings([], []);
  }

  /**
   * 대회 수와 무관하게 조회 횟수가 고정 — 여러 대회를 도는 쪽이 대회마다 같은 조회를 반복하지 않게.
   * 대회가 이 길드 것인지는 검사하지 않으므로 호출자가 먼저 확인한다.
   */
  public async computeStandingsMany(
    guildId: string,
    competitionIds: number[],
  ): Promise<Map<number, CompetitionStandings>> {
    const ids = [...new Set(competitionIds)];
    const result = new Map<number, CompetitionStandings>();
    if (ids.length === 0) return result;

    const teams = await db
      .select({
        competitionId: competitionTeam.competitionId,
        id: competitionTeam.id,
        name: competitionTeam.name,
      })
      .from(competitionTeam)
      .where(inArray(competitionTeam.competitionId, ids));
    const rows = await this.loadAssignedMatches(guildId, ids);

    const teamsById = groupByCompetition(teams);
    const rowsById = groupByCompetition(rows);
    for (const id of ids) {
      result.set(id, foldStandings(teamsById.get(id) ?? [], rowsById.get(id) ?? []));
    }
    return result;
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

    const rows = await this.loadAssignedMatches(guildId, [competitionId]);
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

  private applicationNotFound(): BusinessError {
    return new BusinessError('application not found', 404, {
      type: 'application-not-found',
      isLoggable: false,
    });
  }

  /** 한 사람이 계정 둘로 신청할 수 있어, 수정·취소가 조회(GET /me)와 같은 한 건을 잡게 순서를 맞춘다. */
  private async loadMyApplication(
    executor: DbOrTx,
    competitionId: number,
    memberId: string,
  ): Promise<CompetitionApplication> {
    const [row] = await executor
      .select()
      .from(competitionApplication)
      .where(
        and(
          eq(competitionApplication.competitionId, competitionId),
          eq(competitionApplication.appliedByMemberId, memberId),
        ),
      )
      .orderBy(desc(competitionApplication.createDate), desc(competitionApplication.id))
      .limit(1);
    if (!row) throw this.applicationNotFound();
    return row;
  }

  private async selectApplications(condition: SQL | undefined): Promise<ApplicationJoinRow[]> {
    return db
      .select()
      .from(competitionApplication)
      .innerJoin(riotAccount, eq(riotAccount.playerCode, competitionApplication.playerCode))
      .where(condition)
      .orderBy(desc(competitionApplication.createDate), desc(competitionApplication.id));
  }

  private async attachChampions(rows: ApplicationJoinRow[]): Promise<CompetitionApplicationItem[]> {
    const ids = [...new Set(rows.flatMap((row) => row.competition_application.champions))];
    const champions =
      ids.length > 0
        ? await db
            .select({
              id: champion.id,
              champName: champion.champName,
              champNameEng: champion.champNameEng,
            })
            .from(champion)
            .where(and(inArray(champion.id, ids), eq(champion.isDeleted, false)))
        : [];
    const byId = new Map(champions.map((row) => [row.id, row]));

    return rows.map((row) => ({
      ...row.competition_application,
      riotName: row.riot_account.riotName,
      riotNameTag: row.riot_account.riotNameTag,
      champions: row.competition_application.champions
        .map((id) => byId.get(id))
        .filter((found): found is CompetitionApplicationChampion => found !== undefined),
    }));
  }

  private async assertApplicationFields(
    mainPosition: string,
    subPositions: string[] | undefined,
    champions: string[] | undefined,
    executor: DbOrTx,
  ): Promise<void> {
    if (subPositions && subPositions.length > 0) {
      const distinct = new Set(subPositions);
      if (distinct.size !== subPositions.length || distinct.has(mainPosition)) {
        throw new BusinessError(
          'sub positions must be distinct and must not include the main position',
          400,
          { type: 'sub-position-invalid', isLoggable: false },
        );
      }
    }

    if (!champions || champions.length === 0) return;
    const distinct = [...new Set(champions)];
    if (distinct.length !== champions.length) {
      throw new BusinessError('champions must be distinct', 400, {
        type: 'champion-duplicate',
        isLoggable: false,
      });
    }
    const found = await executor
      .select({ id: champion.id })
      .from(champion)
      .where(and(inArray(champion.id, distinct), eq(champion.isDeleted, false)));
    if (found.length !== distinct.length) {
      const known = new Set(found.map((row) => row.id));
      const missing = distinct.filter((id) => !known.has(id));
      throw new BusinessError(`champion not found: ${missing.join(', ')}`, 400, {
        type: 'champion-not-found',
        isLoggable: false,
      });
    }
  }

  private async teamsWithRoster(
    executor: DbOrTx,
    competitionId: number,
  ): Promise<CompetitionTeamRoster[]> {
    const [teams, members] = await Promise.all([
      executor
        .select()
        .from(competitionTeam)
        .where(eq(competitionTeam.competitionId, competitionId))
        .orderBy(competitionTeam.id),
      executor
        .select({
          teamId: competitionTeamMember.teamId,
          playerCode: competitionTeamMember.playerCode,
          position: competitionTeamMember.position,
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
        position: member.position as CompetitionPosition,
        riotName: member.riotName,
        riotNameTag: member.riotNameTag,
      });
      byTeam.set(member.teamId, roster);
    }
    const rank = (position: string) => POSITION_ORDER.get(position) ?? POSITION_ORDER.size;
    for (const roster of byTeam.values()) {
      roster.sort((a, b) => rank(a.position) - rank(b.position));
    }

    return teams.map((team) => ({ ...team, roster: byTeam.get(team.id) ?? [] }));
  }

  private async deleteTeams(tx: TransactionType, teamIds: number[]): Promise<void> {
    const [{ matches }] = await tx
      .select({ matches: sql<number>`count(*)::integer` })
      .from(competitionMatchTeam)
      .innerJoin(customMatch, eq(customMatch.id, competitionMatchTeam.customMatchId))
      .where(and(inArray(competitionMatchTeam.teamId, teamIds), eq(customMatch.isDeleted, false)));
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
      .where(inArray(competitionMatchTeam.teamId, teamIds));
    if (affected.length > 0) {
      await tx.delete(competitionMatchTeam).where(
        inArray(
          competitionMatchTeam.customMatchId,
          affected.map((row) => row.customMatchId),
        ),
      );
    }

    await tx.delete(competitionTeam).where(inArray(competitionTeam.id, teamIds));
  }

  /** DB를 보지 않고 payload만으로 잡히는 것 — 팀 수·이름·팀당 인원·팀 안 포지션 중복. */
  private normalizeRosterPayload(input: RosterSaveInput): ResolvedRosterTeam[] {
    if (input.teams.length > MAX_TEAMS_PER_COMPETITION) {
      throw new BusinessError(`competition allows up to ${MAX_TEAMS_PER_COMPETITION} teams`, 409, {
        type: 'team-limit-exceeded',
        isLoggable: false,
      });
    }

    const names = new Set<string>();
    const ids = new Set<number>();
    return input.teams.map((team) => {
      if (team.id !== undefined) {
        // 같은 팀이 두 번 오면 뒤엣것이 앞엣것을 조용히 덮어쓴다.
        if (ids.has(team.id)) {
          throw new BusinessError(`team appears twice: ${team.id}`, 400, {
            type: 'team-duplicate',
            isLoggable: false,
          });
        }
        ids.add(team.id);
      }

      const name = CompetitionService.normalizeName(team.name);
      if (!name) {
        throw new BusinessError('team name is required', 400, { isLoggable: false });
      }
      if (names.has(name)) {
        throw new BusinessError('team name already exists', 409, {
          type: 'team-name-exists',
          isLoggable: false,
        });
      }
      names.add(name);

      if (team.members.length > MAX_ROSTER_SIZE) {
        throw new BusinessError(`team allows up to ${MAX_ROSTER_SIZE} members`, 409, {
          type: 'roster-limit-exceeded',
          isLoggable: false,
        });
      }
      if (new Set(team.members.map((member) => member.position)).size !== team.members.length) {
        throw new BusinessError('position is already taken in this team', 409, {
          type: 'roster-position-taken',
          isLoggable: false,
        });
      }

      return {
        id: team.id,
        name,
        captainPlayerCode: team.captainPlayerCode ?? null,
        members: team.members,
      };
    });
  }

  /** 부캐를 본계정으로 바꾼 뒤라야 "한 선수가 두 팀"인지 알 수 있다. */
  private async resolveRosterPlayers(
    guildId: string,
    teams: ResolvedRosterTeam[],
    executor: DbOrTx,
  ): Promise<ResolvedRosterTeam[]> {
    const mainAccounts = await this.toMainAccounts(
      guildId,
      teams.flatMap((team) => [
        ...team.members.map((member) => member.playerCode),
        ...(team.captainPlayerCode ? [team.captainPlayerCode] : []),
      ]),
      executor,
    );
    const resolve = (playerCode: string) => mainAccounts.get(playerCode) ?? playerCode;

    const taken = new Set<string>();
    return teams.map((team) => {
      const members = team.members.map((member) => {
        const playerCode = resolve(member.playerCode);
        if (taken.has(playerCode)) {
          throw new BusinessError('player can belong to only one team in this competition', 409, {
            type: 'roster-duplicate',
            isLoggable: false,
          });
        }
        taken.add(playerCode);
        return { playerCode, position: member.position };
      });

      const captainPlayerCode = team.captainPlayerCode ? resolve(team.captainPlayerCode) : null;
      if (captainPlayerCode && !members.some((member) => member.playerCode === captainPlayerCode)) {
        throw new BusinessError('captain must be on the team roster', 400, {
          type: 'captain-not-in-roster',
          isLoggable: false,
        });
      }
      return { ...team, members, captainPlayerCode };
    });
  }

  /**
   * 삭제를 전부 끝낸 뒤 삽입한다 — 자리를 맞바꾸거나 다른 팀으로 옮기는 저장이,
   * 옮기는 도중의 상태에서 포지션·소속 유니크에 걸리지 않게.
   */
  private async saveRosterMembers(
    tx: TransactionType,
    competitionId: number,
    teams: ResolvedRosterTeam[],
    existingTeams: ExistingRosterTeam[],
  ): Promise<void> {
    const existing = await tx
      .select({
        id: competitionTeamMember.id,
        teamId: competitionTeamMember.teamId,
        playerCode: competitionTeamMember.playerCode,
        position: competitionTeamMember.position,
      })
      .from(competitionTeamMember)
      .where(eq(competitionTeamMember.competitionId, competitionId));

    const seat = (teamId: number, playerCode: string, position: string) =>
      `${teamId}:${playerCode}:${position}`;
    const wanted = new Set(
      teams.flatMap((team) =>
        team.id === undefined
          ? []
          : team.members.map((member) =>
              seat(team.id as number, member.playerCode, member.position),
            ),
      ),
    );

    const stale = existing.filter(
      (row) => !wanted.has(seat(row.teamId, row.playerCode, row.position)),
    );
    if (stale.length > 0) {
      await tx.delete(competitionTeamMember).where(
        inArray(
          competitionTeamMember.id,
          stale.map((row) => row.id),
        ),
      );
    }
    const survived = new Set(
      existing
        .map((row) => seat(row.teamId, row.playerCode, row.position))
        .filter((key) => wanted.has(key)),
    );

    const before = new Map(existingTeams.map((team) => [team.id, team]));
    const teamIdByName = new Map<string, number>();
    const changed: (ResolvedRosterTeam & { id: number })[] = [];
    for (const team of teams) {
      if (team.id === undefined) continue;
      teamIdByName.set(team.name, team.id);
      const saved = before.get(team.id);
      if (saved?.name === team.name && saved.captainPlayerCode === team.captainPlayerCode) continue;
      changed.push({ ...team, id: team.id });
    }

    // 이름은 한 행씩 UPDATE되고 uq_competition_team_name은 문장마다 검사한다 — 두 팀이 이름을
    // 맞바꾸면 먼저 쓰는 쪽이 아직 남아 있는 상대 이름과 부딪힌다. normalizeName이 다듬고 남는
    // 값으로는 나올 수 없는 U+0001 자리표로 먼저 비켜 둔 뒤 최종 이름을 쓴다.
    const renamed = changed.filter((team) => before.get(team.id)?.name !== team.name);
    for (const team of renamed) {
      // eslint-disable-next-line no-await-in-loop
      await tx
        .update(competitionTeam)
        .set({ name: `\u0001${team.id}` })
        .where(eq(competitionTeam.id, team.id));
    }
    for (const team of changed) {
      // eslint-disable-next-line no-await-in-loop
      await tx
        .update(competitionTeam)
        .set({ name: team.name, captainPlayerCode: team.captainPlayerCode })
        .where(eq(competitionTeam.id, team.id));
    }

    const added = teams.filter((team) => team.id === undefined);
    if (added.length > 0) {
      const created = await tx
        .insert(competitionTeam)
        .values(
          added.map((team) => ({
            competitionId,
            name: team.name,
            captainPlayerCode: team.captainPlayerCode,
          })),
        )
        .returning({ id: competitionTeam.id, name: competitionTeam.name });
      for (const row of created) teamIdByName.set(row.name, row.id);
    }

    const inserts: InsertCompetitionTeamMember[] = [];
    for (const team of teams) {
      const teamId = teamIdByName.get(team.name);
      if (teamId === undefined) continue;
      for (const member of team.members) {
        if (survived.has(seat(teamId, member.playerCode, member.position))) continue;
        inserts.push({
          competitionId,
          teamId,
          playerCode: member.playerCode,
          position: member.position,
        });
      }
    }
    if (inserts.length > 0) await tx.insert(competitionTeamMember).values(inserts);
  }

  /** 양 진영이 모두 팀에 귀속된 경기만 (용병전은 팀 전적에서 뺀다). */
  private async loadAssignedMatches(
    guildId: string,
    competitionIds: number[],
  ): Promise<AssignedStandingRow[]> {
    if (competitionIds.length === 0) return [];
    const blueSide = alias(competitionMatchTeam, 'cmt_blue');
    const redSide = alias(competitionMatchTeam, 'cmt_red');
    const rows = (
      await db
        .select({
          competitionId: customMatch.competitionId,
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
            inArray(customMatch.competitionId, competitionIds),
            eq(customMatch.guildId, guildId),
            eq(customMatch.isDeleted, false),
          ),
        )
        .orderBy(desc(customMatch.createDate))
    ).filter(
      (row): row is typeof row & { competitionId: number; blueTeamId: number; redTeamId: number } =>
        row.competitionId != null && row.blueTeamId != null && row.redTeamId != null,
    );
    if (rows.length === 0) return [];

    const sides = await db
      .select({
        customMatchId: matchParticipant.customMatchId,
        gameTeam: matchParticipant.gameTeam,
        won: sql<boolean>`BOOL_OR(${matchParticipant.gameResult} = ${WIN})`,
        kill: sql<number>`COALESCE(SUM(${matchParticipant.kill}), 0)::integer`,
        death: sql<number>`COALESCE(SUM(${matchParticipant.death}), 0)::integer`,
        assist: sql<number>`COALESCE(SUM(${matchParticipant.assist}), 0)::integer`,
      })
      .from(matchParticipant)
      .where(
        and(
          inArray(
            matchParticipant.customMatchId,
            rows.map((row) => row.customMatchId),
          ),
          eq(matchParticipant.isDeleted, false),
        ),
      )
      .groupBy(matchParticipant.customMatchId, matchParticipant.gameTeam);

    const bySide = new Map(
      sides.map((side) => [
        `${side.customMatchId}:${side.gameTeam}`,
        { kill: side.kill, death: side.death, assist: side.assist },
      ]),
    );
    // 양쪽 다 승으로 집계된 손상 데이터는 어느 쪽도 승자로 세지 않는다
    const winnerSide = new Map<string, string | null>();
    for (const side of sides) {
      if (!side.won) continue;
      winnerSide.set(side.customMatchId, winnerSide.has(side.customMatchId) ? null : side.gameTeam);
    }
    const statsOf = (customMatchId: string, gameTeam: string): SideStats =>
      bySide.get(`${customMatchId}:${gameTeam}`) ?? { kill: 0, death: 0, assist: 0 };

    return rows.map((row) => {
      const side = winnerSide.get(row.customMatchId);
      const winnerTeamId = side === 'blue' ? row.blueTeamId : side === 'red' ? row.redTeamId : null;
      return {
        ...row,
        winnerTeamId,
        blue: statsOf(row.customMatchId, 'blue'),
        red: statsOf(row.customMatchId, 'red'),
      };
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

  /** toMainAccount의 다건 판 — 로스터 전체 저장이 선수 수만큼 조회하지 않게. */
  private async toMainAccounts(
    guildId: string,
    playerCodes: string[],
    executor: DbOrTx,
  ): Promise<Map<string, string>> {
    const codes = [...new Set(playerCodes)];
    if (codes.length === 0) return new Map();

    const mapped = await mainAccountMap(guildId, codes, executor);
    const linked = [
      ...new Set(
        [...mapped.entries()]
          .filter(([code, mainAccount]) => mainAccount !== code)
          .map(([, mainAccount]) => mainAccount),
      ),
    ];
    if (linked.length === 0) return mapped;

    const found = await executor
      .select({ playerCode: riotAccount.playerCode })
      .from(riotAccount)
      .where(inArray(riotAccount.playerCode, linked));
    if (found.length !== linked.length) {
      throw new BusinessError('linked main account no longer exists', 400, {
        type: 'main-account-not-found',
        isLoggable: true,
      });
    }
    return mapped;
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
