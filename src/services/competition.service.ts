import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import {
  competition,
  competitionApplication,
  competitionMatchTeam,
  competitionTeam,
  competitionTeamMember,
  customMatch,
  guildAuditLog,
  replay,
  Competition,
  InsertCompetition,
} from '../database/schema.js';
import { BusinessError } from '../types/error.js';
import {
  CompetitionActor,
  CompetitionCreateInput,
  CompetitionDetail,
  CompetitionResolveResult,
  CompetitionStatus,
  CompetitionSummary,
  CompetitionUpdateInput,
} from '../types/competition.js';
import { COMPETITION_STATUS, canTransition, closeDateFor } from './competitionLifecycle.js';
import { systemConfigService } from './systemConfig.service.js';

export interface CompetitionRef {
  id: number;
  name: string;
}

const PG_UNIQUE_VIOLATION = '23505';
const MAX_CANDIDATES = 10;

/** drizzle이 감싼 pg 에러에서 unique 제약 이름을 꺼낸다. unique 위반이 아니면 null. */
const violatedConstraint = (error: unknown): string | null => {
  const pg = (error as { cause?: { code?: string; constraint?: string } })?.cause ?? error;
  const { code, constraint } = (pg ?? {}) as { code?: string; constraint?: string };
  return code === PG_UNIQUE_VIOLATION ? (constraint ?? '') : null;
};

export class CompetitionService {
  /** trim + 연속 공백 축약. "멸망전 1회"와 "멸망전  1회"가 다른 대회로 생기지 않게. */
  public static normalizeName(name: string): string {
    return name.trim().replace(/\s+/g, ' ');
  }

  /**
   * 리플이 붙을 대회를 확정한다. 일반내전(1)은 대회 없음.
   * 스크림·본경기는 competitionId가 없으면 길드의 진행중 대회로 해석한다.
   *
   * lock=true(저장 트랜잭션 안): FOR SHARE로 잡아 트랜잭션이 끝날 때까지 종료(UPDATE)가 못 끼어들게 한다.
   * 봇이 첨부 여러 개를 수십 초에 걸쳐 순차 저장하는 동안 !대회종료가 오면, 잠금이 없을 때
   * 뒤 파일이 닫힌 대회에 붙는다.
   */
  public async resolveForSave(
    guildId: string,
    gameType: string,
    competitionId: number | null | undefined,
    executor: DbOrTx = db,
    lock = false,
  ): Promise<CompetitionRef | null> {
    if (gameType === '1') {
      // 조용히 버리면 호출자는 대회에 올렸다고 믿는다.
      if (competitionId != null) {
        throw new BusinessError('competitionId requires gameType 2 or 3', 400, {
          type: 'competition-requires-game-type',
          isLoggable: false,
        });
      }
      return null;
    }

    const condition =
      competitionId != null
        ? and(eq(competition.id, competitionId), eq(competition.guildId, guildId))
        : and(
            eq(competition.guildId, guildId),
            eq(competition.status, COMPETITION_STATUS.IN_PROGRESS),
          );

    const query = executor
      .select({ id: competition.id, name: competition.name, status: competition.status })
      .from(competition)
      .where(condition)
      .limit(1);
    const [row] = await (lock ? query.for('share') : query);

    if (!row) {
      if (competitionId != null) {
        throw new BusinessError('competition not found', 400, {
          type: 'competition-not-found',
          isLoggable: false,
        });
      }
      // 봇이 읽는 에러 타입이라 상태 이름이 바뀌어도 그대로 둔다.
      throw new BusinessError('no competition in progress', 400, {
        type: 'no-open-competition',
        isLoggable: false,
      });
    }
    if (row.status !== COMPETITION_STATUS.IN_PROGRESS) {
      throw new BusinessError('competition is not in progress', 400, {
        type: 'competition-not-open',
        isLoggable: false,
      });
    }
    return { id: row.id, name: row.name };
  }

  /** 개설. 길드당 진행중 하나·이름 중복은 DB 유니크가 막고 409로 돌려준다. */
  public async create(
    guildId: string,
    input: CompetitionCreateInput,
    actor: CompetitionActor,
  ): Promise<Competition> {
    const name = CompetitionService.normalizeName(input.name);
    if (!name) {
      throw new BusinessError('competition name is required', 400, { isLoggable: false });
    }
    const season = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');

    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(competition)
          .values({
            guildId,
            name,
            season,
            status: input.status ?? COMPETITION_STATUS.RECRUITING,
            approvalRequired: input.approvalRequired ?? true,
          })
          .returning();
        await this.writeAudit(tx, guildId, 'competitionOpen', created, actor);
        return created;
      });
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  public async update(
    guildId: string,
    id: number,
    input: CompetitionUpdateInput,
    actor: CompetitionActor,
  ): Promise<Competition> {
    const patch: Partial<InsertCompetition> = {};
    if (input.name !== undefined) {
      const name = CompetitionService.normalizeName(input.name);
      if (!name) {
        throw new BusinessError('competition name is required', 400, { isLoggable: false });
      }
      patch.name = name;
    }
    if (input.approvalRequired !== undefined) {
      patch.approvalRequired = input.approvalRequired;
    }
    if (Object.keys(patch).length === 0) {
      throw new BusinessError('name or approvalRequired is required', 400, {
        type: 'competition-update-empty',
        isLoggable: false,
      });
    }

    try {
      return await db.transaction(async (tx) => {
        const target = await this.lockCompetition(tx, guildId, id);
        const changes = {
          ...(patch.name !== undefined && patch.name !== target.name
            ? { name: { from: target.name, to: patch.name } }
            : {}),
          ...(patch.approvalRequired !== undefined &&
          patch.approvalRequired !== target.approvalRequired
            ? {
                approvalRequired: {
                  from: target.approvalRequired,
                  to: patch.approvalRequired,
                },
              }
            : {}),
        };
        // 빈 changes만 남은 감사 로그가 쌓이면 실제 수정 이력이 그 사이에 묻힌다.
        if (Object.keys(changes).length === 0) {
          return target;
        }

        const [updated] = await tx
          .update(competition)
          .set(patch)
          .where(eq(competition.id, id))
          .returning();

        await tx.insert(guildAuditLog).values({
          guildId,
          eventType: 'competitionUpdate',
          actorMemberId: actor.memberId,
          detail: {
            competitionId: updated.id,
            name: updated.name,
            changes,
            source: actor.source,
          },
        });
        return updated;
      });
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  /**
   * 상태 전이. 행을 FOR UPDATE로 잡고 검사한다 — 잠금 없이 읽으면 두 요청이 같은 현재 상태를 보고
   * 각자 유효한 전이라고 판정한다(예: 종료 되돌리기 두 건).
   */
  public async changeStatus(
    guildId: string,
    id: number,
    to: CompetitionStatus,
    actor: CompetitionActor,
  ): Promise<Competition> {
    try {
      return await db.transaction(async (tx) => {
        const target = await this.lockCompetition(tx, guildId, id);
        if (!canTransition(target.status, to)) {
          throw new BusinessError(`cannot change status from ${target.status} to ${to}`, 409, {
            type: 'competition-invalid-transition',
            isLoggable: false,
          });
        }

        const [updated] = await tx
          .update(competition)
          .set({ status: to, closeDate: closeDateFor(to) })
          .where(eq(competition.id, id))
          .returning();

        // 종료만 기존 이벤트 타입을 유지한다 — 봇·프론트가 competitionClose를 읽고 있다.
        if (to === COMPETITION_STATUS.CLOSED) {
          await this.writeAudit(tx, guildId, 'competitionClose', updated, actor);
        } else {
          await tx.insert(guildAuditLog).values({
            guildId,
            eventType: 'competitionStatusChange',
            actorMemberId: actor.memberId,
            detail: {
              competitionId: updated.id,
              name: updated.name,
              from: target.status,
              to,
              source: actor.source,
            },
          });
        }
        return updated;
      });
    } catch (error) {
      this.rethrowUnique(error);
    }
  }

  public async list(
    guildId: string,
    filter: { season?: string; status?: CompetitionStatus } = {},
  ): Promise<CompetitionSummary[]> {
    const rows = await db
      .select()
      .from(competition)
      .where(
        and(
          eq(competition.guildId, guildId),
          filter.season ? eq(competition.season, filter.season) : undefined,
          filter.status ? eq(competition.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(competition.createDate), desc(competition.id));
    return this.attachCounts(guildId, rows);
  }

  public async findById(guildId: string, id: number): Promise<CompetitionSummary | null> {
    const [row] = await db
      .select()
      .from(competition)
      .where(and(eq(competition.id, id), eq(competition.guildId, guildId)))
      .limit(1);
    if (!row) return null;
    const [summary] = await this.attachCounts(guildId, [row]);
    return summary;
  }

  /**
   * 대회명 해석. name 없음 → 진행중, 없으면 최근 종료(close_date DESC, id DESC).
   * name 있음 → 정확 일치 1건 → 없으면 부분일치가 정확히 1건일 때만 확정 → 2건 이상이면 candidates.
   */
  public async resolveByName(guildId: string, rawName?: string): Promise<CompetitionResolveResult> {
    const name = rawName ? CompetitionService.normalizeName(rawName) : '';

    if (!name) {
      const [inProgress] = await db
        .select()
        .from(competition)
        .where(
          and(
            eq(competition.guildId, guildId),
            eq(competition.status, COMPETITION_STATUS.IN_PROGRESS),
          ),
        )
        .limit(1);
      const [latest] = inProgress
        ? [inProgress]
        : await db
            .select()
            .from(competition)
            .where(eq(competition.guildId, guildId))
            // DESC는 NULL이 먼저 온다 — close_date 없는 행이 "최근"이 되지 않게
            .orderBy(sql`${competition.closeDate} DESC NULLS LAST`, desc(competition.id))
            .limit(1);
      if (!latest) return { match: null, candidates: [], truncated: false };
      const [summary] = await this.attachCounts(guildId, [latest]);
      return { match: summary, candidates: [], truncated: false };
    }

    const [exact] = await db
      .select()
      .from(competition)
      .where(and(eq(competition.guildId, guildId), eq(competition.name, name)))
      .limit(1);
    if (exact) {
      const [summary] = await this.attachCounts(guildId, [exact]);
      return { match: summary, candidates: [], truncated: false };
    }

    // `%`·`_`는 LIKE 와일드카드라 이스케이프하지 않으면 "%" 입력이 전부와 매칭된다
    const pattern = `%${name.replace(/[\\%_]/g, '\\$&')}%`;
    const partial = await db
      .select()
      .from(competition)
      .where(and(eq(competition.guildId, guildId), ilike(competition.name, pattern)))
      .orderBy(desc(competition.createDate), desc(competition.id))
      .limit(MAX_CANDIDATES + 1);
    const summaries = await this.attachCounts(guildId, partial.slice(0, MAX_CANDIDATES));
    if (summaries.length === 1) return { match: summaries[0], candidates: [], truncated: false };
    return { match: null, candidates: summaries, truncated: partial.length > MAX_CANDIDATES };
  }

  public async getDetail(guildId: string, id: number): Promise<CompetitionDetail | null> {
    const summary = await this.findById(guildId, id);
    if (!summary) return null;

    const matches = await db
      .select({
        gameId: customMatch.id,
        gameType: customMatch.gameType,
        createDate: customMatch.createDate,
      })
      .from(customMatch)
      .where(and(eq(customMatch.competitionId, id), eq(customMatch.isDeleted, false)))
      .orderBy(desc(customMatch.createDate));

    return { ...summary, matches };
  }

  public async close(guildId: string, id: number, actor: CompetitionActor): Promise<Competition> {
    return this.changeStatus(guildId, id, COMPETITION_STATUS.CLOSED, actor);
  }

  /**
   * 삭제. 활성 경기가 있으면 거부. soft-delete된 경기(!drop)는 competition_id를 NULL로 끊고 하드 삭제한다 —
   * 지운 경기에 대회 정보를 남길 이유가 없고, 남기면 FK 때문에 대회를 못 지운다.
   */
  public async remove(guildId: string, id: number, actor: CompetitionActor): Promise<Competition> {
    return db.transaction(async (tx) => {
      const target = await this.lockCompetition(tx, guildId, id);

      const [{ active }] = await tx
        .select({ active: sql<number>`count(*)::integer` })
        .from(customMatch)
        .where(and(eq(customMatch.competitionId, id), eq(customMatch.isDeleted, false)));
      if (active > 0) {
        throw new BusinessError('competition has matches', 409, {
          type: 'competition-has-matches',
          isLoggable: false,
        });
      }

      // 팀·로스터·신청은 FK cascade로 지워지지만, 용병전(team_id NULL) 귀속 행은 지워지지 않는다.
      // 아래에서 custom_match의 대회 참조를 끊으면 어느 대회 것인지도 사라지므로 여기서 함께 지운다.
      await tx.delete(competitionMatchTeam).where(
        inArray(
          competitionMatchTeam.customMatchId,
          tx.select({ id: customMatch.id }).from(customMatch).where(eq(customMatch.competitionId, id)),
        ),
      );

      await tx.update(customMatch).set({ competitionId: null }).where(eq(customMatch.competitionId, id));
      await tx.update(replay).set({ competitionId: null }).where(eq(replay.competitionId, id));
      await tx.delete(competition).where(eq(competition.id, id));
      await this.writeAudit(tx, guildId, 'competitionDelete', target, actor);
      return target;
    });
  }

  // ── private ──

  private async attachCounts(guildId: string, rows: Competition[]): Promise<CompetitionSummary[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const [matches, applications, teams, participants] = await Promise.all([
      db
        .select({
          competitionId: customMatch.competitionId,
          gameType: customMatch.gameType,
          count: sql<number>`count(*)::integer`,
        })
        .from(customMatch)
        .where(
          and(
            eq(customMatch.guildId, guildId),
            inArray(customMatch.competitionId, ids),
            eq(customMatch.isDeleted, false),
          ),
        )
        .groupBy(customMatch.competitionId, customMatch.gameType),
      db
        .select({
          competitionId: competitionApplication.competitionId,
          status: competitionApplication.status,
          count: sql<number>`count(*)::integer`,
        })
        .from(competitionApplication)
        .where(inArray(competitionApplication.competitionId, ids))
        .groupBy(competitionApplication.competitionId, competitionApplication.status),
      db
        .select({
          competitionId: competitionTeam.competitionId,
          count: sql<number>`count(*)::integer`,
        })
        .from(competitionTeam)
        .where(inArray(competitionTeam.competitionId, ids))
        .groupBy(competitionTeam.competitionId),
      db
        .select({
          competitionId: competitionTeamMember.competitionId,
          count: sql<number>`count(*)::integer`,
        })
        .from(competitionTeamMember)
        .where(inArray(competitionTeamMember.competitionId, ids))
        .groupBy(competitionTeamMember.competitionId),
    ]);

    const empty = () => ({
      scrimCount: 0,
      mainCount: 0,
      applicationCount: 0,
      pendingCount: 0,
      teamCount: 0,
      participantCount: 0,
    });
    const byId = new Map<number, ReturnType<typeof empty>>(ids.map((id) => [id, empty()]));
    const accOf = (competitionId: number | null) =>
      competitionId == null ? undefined : byId.get(competitionId);

    for (const row of matches) {
      const acc = accOf(row.competitionId);
      if (!acc) continue;
      if (row.gameType === '2') acc.scrimCount += row.count;
      if (row.gameType === '3') acc.mainCount += row.count;
    }
    for (const row of applications) {
      const acc = accOf(row.competitionId);
      if (!acc) continue;
      acc.applicationCount += row.count;
      if (row.status === 'PENDING') acc.pendingCount += row.count;
    }
    for (const row of teams) {
      const acc = accOf(row.competitionId);
      if (acc) acc.teamCount += row.count;
    }
    for (const row of participants) {
      const acc = accOf(row.competitionId);
      if (acc) acc.participantCount += row.count;
    }

    return rows.map((r) => ({ ...r, ...(byId.get(r.id) ?? empty()) }));
  }

  private async lockCompetition(
    tx: TransactionType,
    guildId: string,
    id: number,
  ): Promise<Competition> {
    const [row] = await tx
      .select()
      .from(competition)
      .where(and(eq(competition.id, id), eq(competition.guildId, guildId)))
      .limit(1)
      .for('update');
    if (!row) {
      throw new BusinessError('competition not found', 404, {
        type: 'competition-not-found',
        isLoggable: false,
      });
    }
    return row;
  }

  private rethrowUnique(error: unknown): never {
    const constraint = violatedConstraint(error);
    if (constraint === 'uq_competition_guild_in_progress') {
      throw new BusinessError('a competition is already in progress', 409, {
        type: 'competition-in-progress-exists',
        isLoggable: false,
      });
    }
    if (constraint === 'uq_competition_guild_name') {
      throw new BusinessError('competition name already exists', 409, {
        type: 'competition-name-exists',
        isLoggable: false,
      });
    }
    throw error;
  }

  private async writeAudit(
    tx: TransactionType,
    guildId: string,
    eventType: 'competitionOpen' | 'competitionClose' | 'competitionDelete',
    target: Competition,
    actor: CompetitionActor,
  ) {
    // 하드 삭제 뒤에도 로그가 읽히도록 이름을 같이 남긴다.
    await tx.insert(guildAuditLog).values({
      guildId,
      eventType,
      actorMemberId: actor.memberId,
      detail: { competitionId: target.id, name: target.name, source: actor.source },
    });
  }
}

export const competitionService = new CompetitionService();
