import { GuildService } from './guild.service.js';
import { discordMemberRoleService } from './discordMemberRole.service.js';
import { discordGuildNicknameService } from './discordGuildNickname.service.js';
import { Role, ADMIN_ROLES } from '../types/role.js';
import { DiscordMemberRole } from '../database/schema.js';
import { SystemError } from '../types/error.js';
import { DiscordGuildAPI, DiscordGuildWithoutRole } from '../types/discordAuth.js';
import { fetchWithTimeout } from '../utils/fetchWithTimeout.js';

const guildService = new GuildService();

const discordApiBaseUrl = 'https://discord.com/api';

// findJoinedGmokGuilds 는 요청마다 Discord API를 (1 + 가입 gmok 길드 수)회 호출한다
// (fetchUserGuilds 1회 + enrichWithNick N회). 프론트가 이 API를 반복 호출하면 그만큼 외부
// 호출이 늘어 429/지연을 유발하므로, 유저별로 조회 promise를 짧은 TTL로 캐시해 외부 호출을
// 상각한다. 값이 아니라 in-flight promise를 캐시하므로 동시 요청은 하나의 외부 조회를 공유한다
// (캐시 스탬피드 방지).
// - 캐시에는 "유저의 gmok 길드 목록(Discord 길드 ∩ gmok 등록 길드, nick 포함)"이 담긴다.
//   따라서 nick뿐 아니라 길드 신규 등록/해제도 warm 캐시 유저에겐 최대 TTL만큼 지연 반영된다.
//   반면 권한 계산·기본권한 보정·nick upsert·role 적용은 캐시와 무관하게 요청마다 수행되므로
//   role 변경은 즉시 반영되고 "조회 시점 보정" 의도도 유지된다.
// - reject 또는 nick 조회 실패(429/timeout)가 섞인 열화 결과는 resolve 후 캐시에서 제거해
//   다음 요청이 재시도하게 한다(일시 장애가 TTL만큼 증폭되는 것 방지).
// - 프로세스 로컬 캐시(공유 아님). 인스턴스가 여러 개면 인스턴스별로 존재하지만 TTL로 한계가 있다.
const GUILD_LIST_TTL_MS = 60 * 1000;
const guildListCache = new Map<
  string,
  { promise: Promise<DiscordGuildWithoutRole[]>; expiresAt: number }
>();

/**
 * @desc 유저가 접근 가능한 Gmok 길드 조회 서비스 (Discord API + 권한 조합)
 * 로그인 유저가 속한 Discord 길드 중 Gmok에 등록된 길드 목록과 길드별 role을 조회한다.
 */
export class DiscordGuildAccessService {
  /**
   * @desc Discord API로 사용자의 길드 목록 조회
   */
  public async fetchUserGuilds(accessToken: string): Promise<Omit<DiscordGuildAPI, 'role' | 'nick'>[]> {
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
   * @desc Gmok 길드에 대해서만 멤버 nickname 조회
   */
  private async enrichWithNick(
    guilds: Omit<DiscordGuildAPI, 'role' | 'nick'>[],
    accessToken: string,
  ): Promise<DiscordGuildWithoutRole[]> {
    return Promise.all(
      guilds.map(async (guild) => {
        let nick: string | undefined = undefined;

        try {
          const memberResult = await fetchWithTimeout(
            `${discordApiBaseUrl}/users/@me/guilds/${guild.id}/member`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );

          if (memberResult.ok) {
            const member = await memberResult.json();
            const fallbackName = member.user?.username?.replace(/\s/g, '');
            nick = member.nick?.replace(/\s/g, '') ?? fallbackName;
          } else {
            // nick은 부가 정보라 실패해도 진행하되, rate-limit(429) 등 추적을 위해 로깅
            console.warn(
              `enrichWithNick: member fetch failed (guild ${guild.id}, status ${memberResult.status})`,
            );
          }
        } catch (error) {
          // nick은 부가 정보이므로 조회 실패(네트워크/타임아웃) 시 undefined로 두되 로깅은 남김
          console.warn(`enrichWithNick: member fetch error (guild ${guild.id})`, error);
        }

        return { ...guild, nick };
      }),
    );
  }

  /**
   * @desc 사용자가 가입한 Discord 길드 중 Gmok에 등록된 길드 목록 조회
   */
  public async findJoinedGmokGuilds(
    accessToken: string,
    memberId?: string,
  ): Promise<DiscordGuildWithoutRole[]> {
    if (memberId) {
      const cached = guildListCache.get(memberId);
      if (cached && cached.expiresAt > Date.now()) return cached.promise;
    }

    const promise = this.fetchJoinedGmokGuilds(accessToken);

    if (memberId) {
      const key = memberId;
      // 만료 항목이 쌓이지 않도록 커지면 한 번 훑어 정리 (프로세스 로컬, 경량)
      if (guildListCache.size > 1000) {
        const now = Date.now();
        for (const [k, value] of guildListCache) {
          if (value.expiresAt <= now) guildListCache.delete(k);
        }
      }

      const entry = { promise, expiresAt: Date.now() + GUILD_LIST_TTL_MS };
      guildListCache.set(key, entry);

      // reject 또는 nick 조회 실패(429/timeout)가 섞인 열화 결과는 캐시에서 제거해 다음 요청이
      // 재시도하게 한다. 그 사이 새 항목이 들어왔으면 건드리지 않도록 동일 entry일 때만 삭제.
      const evict = () => {
        if (guildListCache.get(key) === entry) guildListCache.delete(key);
      };
      promise
        .then((enriched) => {
          if (enriched.some((g) => g.nick === undefined)) evict();
        })
        .catch(evict);
    }

    return promise;
  }

  /** Discord 조회 실체: gmok 등록 길드와 유저 가입 길드의 교집합 + nick enrich (캐시 없이 순수 조회) */
  private async fetchJoinedGmokGuilds(accessToken: string): Promise<DiscordGuildWithoutRole[]> {
    const [gmokGuildsResponse, userDiscordGuilds] = await Promise.all([
      guildService.findAllGuilds({ page: 1, limit: 1000 }),
      this.fetchUserGuilds(accessToken),
    ]);

    const gmokGuildIdSet = new Set(gmokGuildsResponse.result.map((g) => g.id));
    const gmokGuilds = userDiscordGuilds.filter((g) => gmokGuildIdSet.has(g.id));

    return this.enrichWithNick(gmokGuilds, accessToken);
  }

  /**
   * @desc Admin 권한 사용자가 접근 가능한 전체 Gmok 길드 목록 조회
   */
  public async findAdminGmokGuilds(activeRoles: DiscordMemberRole[]): Promise<DiscordGuildAPI[]> {
    const gmokGuildsResponse = await guildService.findAllGuilds({ page: 1, limit: 1000 });
    const roleByGuildId = new Map(activeRoles.map((r) => [r.guildId, r.role as Role]));
    const adminRole = roleByGuildId.get(null) ?? ('adminNormal' as Role);

    return gmokGuildsResponse.result.map((g) => ({
      id: g.id,
      name: g.name,
      icon: '',
      banner: '',
      role: adminRole,
    }));
  }

  /**
   * @desc Gmok 길드 목록에 길드별 권한 정보 적용
   */
  public applyRolesToGuilds(
    guilds: DiscordGuildWithoutRole[],
    activeRoles: DiscordMemberRole[],
  ): DiscordGuildAPI[] {
    const roleByGuildId = new Map(activeRoles.map((r) => [r.guildId, r.role as Role]));

    return guilds.map((g) => ({
      ...g,
      role: roleByGuildId.get(g.id) ?? ('userNormal' as Role),
    }));
  }

  /**
   * @desc 로그인 유저의 gmok 길드 목록(길드별 role 포함)을 반환 — getGmokGuilds 컨트롤러의 오케스트레이션.
   *  흐름: 활성 권한 조회 → (admin이면 전체 gmok 길드 / 아니면 가입 gmok 길드 조회 + 기본권한 보정)
   *        → 멤버관리 표시용 nick upsert(fire-and-forget) → 길드별 role 적용.
   *  동작은 기존 컨트롤러 인라인 로직과 동일. Discord 외부 호출은 findJoinedGmokGuilds 캐시로 상각됨.
   */
  public async getGmokGuildsForMember(
    memberId: string,
    accessToken: string,
  ): Promise<DiscordGuildAPI[]> {
    const activeRoles = await discordMemberRoleService.getActiveRoles(memberId);
    const isAdmin = activeRoles.some((r) => ADMIN_ROLES.includes(r.role as Role));

    if (isAdmin) {
      return this.findAdminGmokGuilds(activeRoles);
    }

    const joinedGmokGuilds = await this.findJoinedGmokGuilds(accessToken, memberId);
    const ensuredRoles = await discordMemberRoleService.ensureDefaultRolesForGuilds(
      memberId,
      joinedGmokGuilds.map((g) => g.id),
      activeRoles,
    );

    // 멤버 관리 화면 식별용 길드 별명 저장 (best-effort). 응답을 막지 않도록 fire-and-forget
    // (서비스 내부에서 이미 에러 로깅 — 여기선 unhandled rejection만 방지).
    discordGuildNicknameService
      .upsertGuildNicknames(
        memberId,
        joinedGmokGuilds.map((g) => ({ guildId: g.id, nickname: g.nick })),
      )
      .catch(() => {});

    return this.applyRolesToGuilds(joinedGmokGuilds, ensuredRoles);
  }
}

export const discordGuildAccessService = new DiscordGuildAccessService();
