import { eq, and, or, isNull } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { DiscordMemberRole, discordMemberRole } from '../database/schema.js';
import { ADMIN_ROLES, Role } from '../types/role.js';

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
}

export const discordMemberRoleService = new DiscordMemberRoleService();
