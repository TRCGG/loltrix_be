import { eq, and, or, isNull } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordMemberRole } from '../database/schema.js';
import { ADMIN_ROLES, Role } from '../types/role.js';
import { DiscordMemberGuildService } from './discordMemberGuild.service.js';

const discordMemberGuildService = new DiscordMemberGuildService();

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
   * @desc 로그인 시 기본 권한(userNormal) 삽입
   * - 이미 권한이 있는 길드는 스킵
   * - 권한이 없는 길드에만 userNormal 삽입
   */
  public async insertDefaultRolesIfNotExists(memberId: string, accessToken: string): Promise<void> {
    const gmokGuilds = await discordMemberGuildService.findUserGmokGuilds(accessToken, []);

    if (gmokGuilds.length === 0) return;

    const existing = await this.getActiveRoles(memberId);

    // Admin 권한이 있으면 길드별 userNormal 삽입 불필요
    const isAdmin = existing.some((r) => ADMIN_ROLES.includes(r.role as Role));
    if (isAdmin) return;

    const existingGuildIds = new Set(existing.map((r) => r.guildId));
    const newGuilds = gmokGuilds.filter((g) => !existingGuildIds.has(g.id));

    if (newGuilds.length === 0) return;

    await db.insert(discordMemberRole).values(
      newGuilds.map((g) => ({ memberId, role: 'userNormal', guildId: g.id })),
    );
  }
}

export const discordMemberRoleService = new DiscordMemberRoleService();
