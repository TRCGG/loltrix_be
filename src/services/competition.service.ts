import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { db, DbOrTx, TransactionType } from '../database/connectionPool.js';
import { competition, customMatch, guildAuditLog, replay, Competition } from '../database/schema.js';
import { BusinessError } from '../types/error.js';
import {
  CompetitionActor,
  CompetitionDetail,
  CompetitionResolveResult,
  CompetitionStatus,
  CompetitionSummary,
} from '../types/competition.js';
import { systemConfigService } from './systemConfig.service.js';

export const COMPETITION_STATUS = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;

export interface CompetitionRef {
  id: number;
  name: string;
}

const PG_UNIQUE_VIOLATION = '23505';

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
   * 스크림·본경기는 competitionId가 없으면 길드의 OPEN 대회로 해석한다.
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
    if (gameType === '1') return null;

    const condition =
      competitionId != null
        ? and(eq(competition.id, competitionId), eq(competition.guildId, guildId))
        : and(eq(competition.guildId, guildId), eq(competition.status, COMPETITION_STATUS.OPEN));

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
      throw new BusinessError('no open competition', 400, {
        type: 'no-open-competition',
        isLoggable: false,
      });
    }
    if (row.status !== COMPETITION_STATUS.OPEN) {
      throw new BusinessError('competition is closed', 400, {
        type: 'competition-not-open',
        isLoggable: false,
      });
    }
    return { id: row.id, name: row.name };
  }

  /** 개설. 길드당 OPEN 하나·이름 중복은 DB 유니크가 막고 409로 돌려준다. */
  public async create(guildId: string, rawName: string, actor: CompetitionActor): Promise<Competition> {
    const name = CompetitionService.normalizeName(rawName);
    if (!name) {
      throw new BusinessError('competition name is required', 400, { isLoggable: false });
    }
    const season = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');

    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(competition)
          .values({ guildId, name, season, status: COMPETITION_STATUS.OPEN })
          .returning();
        await this.writeAudit(tx, guildId, 'competitionOpen', created, actor);
        return created;
      });
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint === 'uq_competition_guild_open') {
        throw new BusinessError('an open competition already exists', 409, {
          type: 'competition-open-exists',
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
   * 대회명 해석. name 없음 → OPEN, 없으면 최근 종료(close_date DESC, id DESC).
   * name 있음 → 정확 일치 1건 → 없으면 부분일치가 정확히 1건일 때만 확정 → 2건 이상이면 candidates.
   */
  public async resolveByName(guildId: string, rawName?: string): Promise<CompetitionResolveResult> {
    const name = rawName ? CompetitionService.normalizeName(rawName) : '';

    if (!name) {
      const [open] = await db
        .select()
        .from(competition)
        .where(and(eq(competition.guildId, guildId), eq(competition.status, COMPETITION_STATUS.OPEN)))
        .limit(1);
      const [latest] = open
        ? [open]
        : await db
            .select()
            .from(competition)
            .where(eq(competition.guildId, guildId))
            .orderBy(desc(competition.closeDate), desc(competition.id))
            .limit(1);
      if (!latest) return { match: null, candidates: [] };
      const [summary] = await this.attachCounts(guildId, [latest]);
      return { match: summary, candidates: [] };
    }

    const [exact] = await db
      .select()
      .from(competition)
      .where(and(eq(competition.guildId, guildId), eq(competition.name, name)))
      .limit(1);
    if (exact) {
      const [summary] = await this.attachCounts(guildId, [exact]);
      return { match: summary, candidates: [] };
    }

    const partial = await db
      .select()
      .from(competition)
      .where(and(eq(competition.guildId, guildId), ilike(competition.name, `%${name}%`)))
      .orderBy(desc(competition.createDate), desc(competition.id))
      .limit(10);
    const summaries = await this.attachCounts(guildId, partial);
    if (summaries.length === 1) return { match: summaries[0], candidates: [] };
    return { match: null, candidates: summaries };
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
    return db.transaction(async (tx) => {
      const [closed] = await tx
        .update(competition)
        .set({ status: COMPETITION_STATUS.CLOSED, closeDate: new Date() })
        .where(
          and(
            eq(competition.id, id),
            eq(competition.guildId, guildId),
            eq(competition.status, COMPETITION_STATUS.OPEN),
          ),
        )
        .returning();
      if (!closed) {
        throw new BusinessError('open competition not found', 404, {
          type: 'competition-not-open',
          isLoggable: false,
        });
      }
      await this.writeAudit(tx, guildId, 'competitionClose', closed, actor);
      return closed;
    });
  }

  /**
   * 삭제. 활성 경기가 있으면 거부. soft-delete된 경기(!drop)는 competition_id를 NULL로 끊고 하드 삭제한다 —
   * 지운 경기에 대회 정보를 남길 이유가 없고, 남기면 FK 때문에 대회를 못 지운다.
   */
  public async remove(guildId: string, id: number, actor: CompetitionActor): Promise<Competition> {
    return db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(competition)
        .where(and(eq(competition.id, id), eq(competition.guildId, guildId)))
        .limit(1)
        .for('update');
      if (!target) {
        throw new BusinessError('competition not found', 404, {
          type: 'competition-not-found',
          isLoggable: false,
        });
      }

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
    const counts = await db
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
      .groupBy(customMatch.competitionId, customMatch.gameType);

    const byId = new Map<number, { scrimCount: number; mainCount: number }>();
    for (const c of counts) {
      if (c.competitionId == null) continue;
      const acc = byId.get(c.competitionId) ?? { scrimCount: 0, mainCount: 0 };
      if (c.gameType === '2') acc.scrimCount += c.count;
      if (c.gameType === '3') acc.mainCount += c.count;
      byId.set(c.competitionId, acc);
    }
    return rows.map((r) => ({ ...r, ...(byId.get(r.id) ?? { scrimCount: 0, mainCount: 0 }) }));
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
