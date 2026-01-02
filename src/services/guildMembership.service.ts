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
  constructor() {}

  /**
   * @desc 사용자가 가입한 길드 목록 중,
   * Gmok(DB)에 등록된 길드 목록만 필터링하여 반환
   */
  public async findUserGmokGuilds(accessToken: string) {
    const [gmokGuildsResponse, userDiscordGuilds] = await Promise.all([
      guildService.findAllGuilds({ page: 1, limit: 1000 }),
      discordAuthService.fetchUserGuilds(accessToken),
    ]);

    // DB에서 조회한 Gmok 길드 목록
    const allGmokGuilds = gmokGuildsResponse.result; // 타입: Guild[]

    // 비교 로직
    const gmokGuildIdSet = new Set(allGmokGuilds.map((guild) => guild.id));

    // 사용자의 Discord 길드 목록을 순회하며,
    // Gmok 길드 Set에 ID가 존재하는지 확인
    const filteredGuilds = userDiscordGuilds.filter((userGuild: DiscordGuildAPI) =>
      gmokGuildIdSet.has(userGuild.id),
    );

    return filteredGuilds;
  }
}
