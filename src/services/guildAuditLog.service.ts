import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordGuildMember, discordMember, guildAuditLog } from '../database/schema.js';
import { GuildAuditLogItem, GuildAuditLogType } from '../types/guildMember.js';

/**
 * @desc 클랜관리 화면용 관리 로그 조회 서비스
 * - guild_audit_log 단일 테이블에서 역할 부여/회수(roleChange) + 리플 삭제(replayDelete)를
 *   시간순(최신순) 피드로 반환한다.
 * - 표시명 = discord_guild_member.nickname ?? discord_member.display_name ?? member_id
 *   (봇 !drop 사용자는 웹 로그인 이력이 없을 수 있어 id fallback이 정상 경로).
 */
export class GuildAuditLogService {
  public async getGuildAuditLogs(
    guildId: string,
    {
      type = 'all',
      page = 1,
      limit = 50,
    }: { type?: GuildAuditLogType | 'all'; page?: number; limit?: number },
  ): Promise<{ result: GuildAuditLogItem[]; totalCount: number }> {
    const offset = (page - 1) * limit;

    const conditions = [eq(guildAuditLog.guildId, guildId)];
    if (type !== 'all') {
      conditions.push(eq(guildAuditLog.eventType, type));
    }
    const whereCondition = and(...conditions);

    const [rows, [countRow]] = await Promise.all([
      db
        .select()
        .from(guildAuditLog)
        .where(whereCondition)
        .orderBy(desc(guildAuditLog.createDate))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::integer` })
        .from(guildAuditLog)
        .where(whereCondition),
    ]);

    // 페이지에 등장한 멤버 id만 모아 표시명을 한 번에 해석 ('bot'은 실제 멤버가 아님)
    const memberIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.actorMemberId, r.targetMemberId])
          .filter((v): v is string => !!v && v !== 'bot'),
      ),
    ];

    const nameRows = memberIds.length
      ? await db
          .select({
            memberId: discordMember.id,
            displayName: sql<string>`COALESCE(${discordGuildMember.nickname}, ${discordMember.displayName}, ${discordMember.id})`,
          })
          .from(discordMember)
          .leftJoin(
            discordGuildMember,
            and(
              eq(discordGuildMember.memberId, discordMember.id),
              eq(discordGuildMember.guildId, guildId),
            ),
          )
          .where(inArray(discordMember.id, memberIds))
      : [];

    const nameMap = new Map(nameRows.map((r) => [r.memberId, r.displayName]));

    const result: GuildAuditLogItem[] = rows.map((r) => {
      const detail = r.detail as {
        fromRole?: string;
        toRole?: string;
        gameId?: string;
        source?: string;
      };
      return {
        type: r.eventType as GuildAuditLogType,
        createDate: r.createDate,
        actorMemberId: r.actorMemberId,
        actorDisplayName: nameMap.get(r.actorMemberId) ?? r.actorMemberId,
        targetMemberId: r.targetMemberId,
        targetDisplayName: r.targetMemberId
          ? (nameMap.get(r.targetMemberId) ?? r.targetMemberId)
          : null,
        fromRole: detail.fromRole ?? null,
        toRole: detail.toRole ?? null,
        gameId: detail.gameId ?? null,
        source: detail.source ?? null,
      };
    });

    return { result, totalCount: countRow?.count || 0 };
  }
}

export const guildAuditLogService = new GuildAuditLogService();
