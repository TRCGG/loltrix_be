import { GuildService } from './guild.service.js';
import { SystemError } from '../types/error.js';
import { DiscordGuildAPI } from '../types/discordAuth.js';

const guildService = new GuildService();

const DISCORD_API_TIMEOUT = 10000;
const discordApiBaseUrl = 'https://discord.com/api';

/**
 * @desc discord_member ↔ guild 관계 서비스
 * Discord 멤버가 속한 길드와 Gmok에 등록된 길드 간의 관계를 처리합니다.
 */
export class DiscordMemberGuildService {
  /**
   * @desc 타임아웃이 적용된 Fetch 헬퍼
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeout: number = DISCORD_API_TIMEOUT,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new SystemError(`Discord API Request Timed out after ${timeout}ms`, 504);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * @desc Discord API로 사용자의 길드 목록 조회
   */
  public async fetchUserGuilds(accessToken: string): Promise<DiscordGuildAPI[]> {
    try {
      const result = await this.fetchWithTimeout(`${discordApiBaseUrl}/users/@me/guilds`, {
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

    const userDiscordGuilds = await this.fetchUserGuilds(accessToken);
    const gmokGuildIdSet = new Set(allGmokGuilds.map((g) => g.id));

    return userDiscordGuilds.filter((userGuild) => gmokGuildIdSet.has(userGuild.id));
  }
}

export const discordMemberGuildService = new DiscordMemberGuildService();
