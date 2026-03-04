// discordAuth.service.ts
import { DiscordAuthService } from './discordAuth.service.js';
import { GuildService } from './guild.service.js';
import { DiscordGuildAPI } from '../types/discordAuth.js';

const guildService = new GuildService();
const discordAuthService = new DiscordAuthService();

/**
 * @desc 사용자와 길드 간의 관계 service
 * GUildService 와 DiscordAuthService 두개의 서비스 import
 */
export class GuildMembershipService {
  /**
   * @desc 사용자가 가입한 길드 목록 중 Gmok(DB)에 등록된 길드 목록만 필터링하여 반환
   * - isAdmin=true: Discord 멤버십 무관, DB의 전체 Gmok 길드 반환
   * - isAdmin=false: 사용자가 가입한 Discord 길드 중 Gmok 길드만 반환
   */
  public async findUserGmokGuilds(accessToken: string, isAdmin: boolean): Promise<DiscordGuildAPI[]> {
    const gmokGuildsResponse = await guildService.findAllGuilds({ page: 1, limit: 1000 });
    const allGmokGuilds = gmokGuildsResponse.result;

    if (isAdmin) {
      return allGmokGuilds.map((g) => ({
        id: g.id,
        name: g.name,
        icon: '',
        banner: '',
      }));
    }

    const userDiscordGuilds = await discordAuthService.fetchUserGuilds(accessToken);
    const gmokGuildIdSet = new Set(allGmokGuilds.map((g) => g.id));

    return userDiscordGuilds.filter((userGuild: DiscordGuildAPI) =>
      gmokGuildIdSet.has(userGuild.id),
    );
  }
}
