import { GuildService } from './guild.service.js';
import { Role, ADMIN_ROLES } from '../types/role.js';
import { DiscordMemberRole } from '../database/schema.js';
import { SystemError } from '../types/error.js';
import { DiscordGuildAPI } from '../types/discordAuth.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

const guildService = new GuildService();

const discordApiBaseUrl = 'https://discord.com/api';

/**
 * @desc discord_member ↔ guild 관계 서비스
 * Discord 멤버가 속한 길드와 Gmok에 등록된 길드 간의 관계를 처리합니다.
 */
export class DiscordMemberGuildService {
  /**
   * @desc Discord API로 사용자의 길드 목록 조회
   */
  public async fetchUserGuilds(accessToken: string): Promise<Omit<DiscordGuildAPI, 'role'>[]> {
    try {
      const result = await fetchWithTimeout(`${discordApiBaseUrl}/users/@me/guilds`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!result.ok) {
        throw new SystemError('Failed to fetch Discord guilds', 500);
      }

      const fullGuilds: any[] = await result.json();

      return fullGuilds.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        banner: guild.banner,
      }));
    } catch (error) {
      console.error('fetchUserGuilds service error', error);
      if (error instanceof SystemError) throw error;
      throw new SystemError('Failed to get guilds', 500);
    }
  }

  /**
   * @desc 사용자가 가입한 Gmok 길드 목록 + 길드별 권한 반환
   * - admin(adminNormal 이상): 전체 길드 목록, role은 DB 값 그대로
   * - 일반 유저: 가입한 Discord 길드 중 Gmok 길드만, 길드별 role
   */
  public async findUserGmokGuilds(
    accessToken: string,
    activeRoles: DiscordMemberRole[],
  ): Promise<DiscordGuildAPI[]> {
    const gmokGuildsResponse = await guildService.findAllGuilds({ page: 1, limit: 1000 });
    const allGmokGuilds = gmokGuildsResponse.result;

    const isAdmin = activeRoles.some((r) => ADMIN_ROLES.includes(r.role as Role));
    const roleByGuildId = new Map(activeRoles.map((r) => [r.guildId, r.role as Role]));

    if (isAdmin) {
      const adminRole = roleByGuildId.get(null) ?? ('adminNormal' as Role);
      return allGmokGuilds.map((g) => ({ id: g.id, name: g.name, icon: '', banner: '', role: adminRole }));
    }

    const userDiscordGuilds = await this.fetchUserGuilds(accessToken);
    const gmokGuildIdSet = new Set(allGmokGuilds.map((g) => g.id));

    return userDiscordGuilds
      .filter((g) => gmokGuildIdSet.has(g.id))
      .map((g) => ({ ...g, role: roleByGuildId.get(g.id) ?? ('userNormal' as Role) }));
  }
}

export const discordMemberGuildService = new DiscordMemberGuildService();
