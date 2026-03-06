import { eq, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordMemberRole } from '../database/schema.js';
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
   * @desc 최초 로그인 시 기본 권한(userNormal) 삽입
   * - 이미 활성 role이 있으면 스킵
   * - 없으면 가입한 Gmok 길드마다 userNormal 삽입
   */
  public async insertDefaultRolesIfNotExists(memberId: string, accessToken: string): Promise<void> {
    const existing = await this.getActiveRoles(memberId);

    if (existing.length > 0) return;

    const gmokGuilds = await discordMemberGuildService.findUserGmokGuilds(accessToken, []);

    if (gmokGuilds.length === 0) return;

    await db.insert(discordMemberRole).values(
      gmokGuilds.map((g) => ({ memberId, role: 'userNormal', guildId: g.id })),
    );
  }
}

export const discordMemberRoleService = new DiscordMemberRoleService();
