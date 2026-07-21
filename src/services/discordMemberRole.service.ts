import { eq, and, or, isNull, sql, desc } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import {
  DiscordMemberRole,
  discordMemberRole,
  discordMember,
  discordGuildMember,
  guildAuditLog,
} from '../database/schema.js';
import { ADMIN_ROLES, ROLES, Role, hasMinRole } from '../types/role.js';
import { BusinessError } from '../types/error.js';

/** guildManager가 웹에서 부여/회수할 수 있는 역할 (권한 상한: userUploader까지) */
export type ManageableRole = Extract<Role, 'userNormal' | 'userUploader'>;

const SYNC_ACTOR = 'discord_sync';

/**
 * @desc discord_member_role DB 조작 서비스
 */
export class DiscordMemberRoleService {
  /**
   * @desc 활성 role 목록 조회
   */
  public async getActiveRoles(memberId: string) {
    return db
      .select()
      .from(discordMemberRole)
      .where(and(eq(discordMemberRole.memberId, memberId), eq(discordMemberRole.isDeleted, false)));
  }

  /**
   * @desc 특정 길드 스코프 + admin(guildId IS NULL) 역할만 조회
   */
  public async getActiveRolesByGuild(memberId: string, guildId: string) {
    return db
      .select()
      .from(discordMemberRole)
      .where(
        and(
          eq(discordMemberRole.memberId, memberId),
          eq(discordMemberRole.isDeleted, false),
          or(eq(discordMemberRole.guildId, guildId), isNull(discordMemberRole.guildId)),
        ),
      );
  }

  /**
   * @desc 가입한 Gmok 길드 중 권한이 없는 길드에 기본 권한(userNormal) 삽입
   */
  public async ensureDefaultRolesForGuilds(
    memberId: string,
    guildIds: string[],
    activeRoles: DiscordMemberRole[],
  ): Promise<DiscordMemberRole[]> {
    const isAdmin = activeRoles.some((r) => ADMIN_ROLES.includes(r.role as Role));
    if (isAdmin) return activeRoles;

    const uniqueGuildIds = [...new Set(guildIds)];
    const existingGuildIds = new Set(activeRoles.map((r) => r.guildId));
    const missingGuildIds = uniqueGuildIds.filter((guildId) => !existingGuildIds.has(guildId));

    if (missingGuildIds.length === 0) return activeRoles;

    await db
      .insert(discordMemberRole)
      .values(missingGuildIds.map((guildId) => ({ memberId, role: 'userNormal', guildId })))
      .onConflictDoNothing();

    return this.getActiveRoles(memberId);
  }

  /**
   * @desc Discord 길드 권한 기준 guildManager 부여/회수.
   * admin 이상과 guildManager 미만의 수동 부여(userUploader)는 건드리지 않는다.
   */
  public async syncGuildManagerRoles(
    memberId: string,
    guildManagerFlags: { guildId: string; isDiscordManager: boolean }[],
    activeRoles: DiscordMemberRole[],
  ): Promise<DiscordMemberRole[]> {
    if (activeRoles.some((r) => ADMIN_ROLES.includes(r.role as Role))) return activeRoles;

    const roleByGuildId = new Map(activeRoles.map((r) => [r.guildId, r]));
    let changed = false;

    for (const { guildId, isDiscordManager } of guildManagerFlags) {
      const current = roleByGuildId.get(guildId);
      if (!current) continue;

      // 알 수 없는 role 값은 hasMinRole 판정이 무의미해져 가드가 뚫린다.
      if (!(ROLES as readonly string[]).includes(current.role)) continue;

      const snapshotRole = current.role as Role;
      if (hasMinRole(snapshotRole, 'adminNormal')) continue;
      if (isDiscordManager === (snapshotRole === 'guildManager')) continue;

      try {
        // 스냅샷은 트랜잭션 밖에서 읽은 값이라 그대로 쓰면 동시 요청끼리 감사 로그가 중복되고,
        // 사이에 낀 수동 부여를 덮어쓰며 fromRole까지 틀리게 남는다. 잠근 뒤 다시 판정한다.
        const applied = await db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(discordMemberRole)
            .where(and(eq(discordMemberRole.id, current.id), eq(discordMemberRole.isDeleted, false)))
            .limit(1)
            .for('update');

          if (!locked || !(ROLES as readonly string[]).includes(locked.role)) return false;

          const lockedRole = locked.role as Role;
          if (hasMinRole(lockedRole, 'adminNormal')) return false;
          if (isDiscordManager === (lockedRole === 'guildManager')) return false;

          const toRole: Role = isDiscordManager ? 'guildManager' : 'userNormal';

          await tx
            .update(discordMemberRole)
            .set({ role: toRole, updateDate: new Date() })
            .where(eq(discordMemberRole.id, locked.id));

          await tx.insert(guildAuditLog).values({
            guildId,
            eventType: 'roleChange',
            actorMemberId: SYNC_ACTOR,
            targetMemberId: memberId,
            detail: { fromRole: lockedRole, toRole, source: 'discordPermission' },
          });

          return true;
        });

        if (applied) changed = true;
      } catch (error) {
        // 한 길드 실패가 길드 목록 응답을 막지 않도록 격리.
        console.error(`[roleSync] 동기화 실패 member=${memberId} guild=${guildId}`, error);
      }
    }

    return changed ? this.getActiveRoles(memberId) : activeRoles;
  }

  /**
   * @desc 멤버 관리 화면용: 길드 스코프 역할 행이 있는 멤버 목록 조회 (표시명 + 현재 role)
   * - 대상 = 해당 guildId에 discord_member_role 행이 있는 멤버(= 웹 로그인 이력자).
   * - 표시명 = discord_guild_member.nickname ?? discord_member.display_name ?? member_id.
   * - search는 표시명 부분일치(대소문자 무시, LIKE 이스케이프).
   */
  public async getGuildMembersWithRoles(
    guildId: string,
    { search, page = 1, limit = 50 }: { search?: string; page?: number; limit?: number },
  ) {
    const offset = (page - 1) * limit;
    const displayNameSql = sql<string>`COALESCE(${discordGuildMember.nickname}, ${discordMember.displayName}, ${discordMemberRole.memberId})`;

    const conditions = [
      eq(discordMemberRole.guildId, guildId),
      eq(discordMemberRole.isDeleted, false),
    ];

    if (search) {
      const escaped = search.replace(/[%_\\]/g, '\\$&').toLowerCase();
      conditions.push(sql`LOWER(${displayNameSql}) LIKE ${`%${escaped}%`}`);
    }

    const whereCondition = and(...conditions);

    const baseQuery = () =>
      db
        .select({
          memberId: discordMemberRole.memberId,
          displayName: displayNameSql,
          avatarUrl: discordMember.avatarUrl,
          role: discordMemberRole.role,
        })
        .from(discordMemberRole)
        .innerJoin(discordMember, eq(discordMemberRole.memberId, discordMember.id))
        .leftJoin(
          discordGuildMember,
          and(
            eq(discordGuildMember.memberId, discordMemberRole.memberId),
            eq(discordGuildMember.guildId, guildId),
          ),
        );

    const [result, [countResult]] = await Promise.all([
      baseQuery()
        .where(whereCondition)
        .orderBy(desc(discordMemberRole.updateDate))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::integer` })
        .from(discordMemberRole)
        .innerJoin(discordMember, eq(discordMemberRole.memberId, discordMember.id))
        .leftJoin(
          discordGuildMember,
          and(
            eq(discordGuildMember.memberId, discordMemberRole.memberId),
            eq(discordGuildMember.guildId, guildId),
          ),
        )
        .where(whereCondition),
    ]);

    return { result, totalCount: countResult?.count || 0 };
  }

  /**
   * @desc guildManager가 대상 멤버의 역할을 userNormal <-> userUploader로 변경 (부여/회수)
   * - 불변식: (member, guild) 1행을 UPDATE (신규 행 추가 X → unique 유지).
   * - 권한 상승 차단: 대상이 guildManager 이상이면 거부. toRole은 타입/검증으로 userUploader 상한.
   * - 길드 스코프: 대상의 (member, guildId) 역할 행이 없으면 404 (타 길드/웹 로그인 이력 없음).
   * - idempotent: 이미 같은 역할이면 변경/로그 없이 changed:false 반환.
   * - 감사: 실제 변경 시 guild_audit_log에 roleChange 이벤트 기록 (actor 포함).
   */
  public async grantOrRevokeRole(
    actorMemberId: string,
    guildId: string,
    targetMemberId: string,
    toRole: ManageableRole,
  ) {
    return db.transaction(async (tx) => {
      // FOR UPDATE: 동시 부여/회수 요청이 stale role을 읽어 감사 로그 중복·lost update가
      // 생기지 않도록 대상 행을 잠근다 (READ COMMITTED에서 read-check-update 보호).
      const [current] = await tx
        .select()
        .from(discordMemberRole)
        .where(
          and(
            eq(discordMemberRole.memberId, targetMemberId),
            eq(discordMemberRole.guildId, guildId),
            eq(discordMemberRole.isDeleted, false),
          ),
        )
        .limit(1)
        .for('update');

      if (!current) {
        throw new BusinessError(
          'Target member not found in this guild (web login history required)',
          404,
          { isLoggable: false },
        );
      }

      // 알 수 없는 role 값 방어: ROLE_HIERARCHY에 없는 값이면 hasMinRole이 false를 반환해
      // 상승 차단 가드가 우회되므로, enum 외 값(레거시/수동 입력)은 조작 자체를 거부한다.
      if (!(ROLES as readonly string[]).includes(current.role)) {
        throw new BusinessError(`Cannot modify unknown role: ${current.role}`, 409, {
          isLoggable: true,
        });
      }

      const currentRole = current.role as Role;

      // 권한 상승 차단: 대상이 guildManager 이상이면 웹에서 조작 불가
      if (hasMinRole(currentRole, 'guildManager')) {
        throw new BusinessError('Cannot modify guildManager or higher role', 403, {
          isLoggable: true,
        });
      }

      // idempotent: 동일 역할이면 no-op
      if (currentRole === toRole) {
        return { memberId: targetMemberId, guildId, role: currentRole, changed: false };
      }

      await tx
        .update(discordMemberRole)
        .set({ role: toRole, updateDate: new Date() })
        .where(eq(discordMemberRole.id, current.id));

      await tx.insert(guildAuditLog).values({
        guildId,
        eventType: 'roleChange',
        actorMemberId,
        targetMemberId,
        detail: { fromRole: currentRole, toRole },
      });

      return { memberId: targetMemberId, guildId, role: toRole, changed: true };
    });
  }
}

export const discordMemberRoleService = new DiscordMemberRoleService();
