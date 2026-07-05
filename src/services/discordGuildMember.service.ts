import { sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordGuildMember } from '../database/schema.js';

/**
 * @desc discord_guild_member(길드별 Discord 별명) 조작 서비스
 * - 멤버 관리 화면에서 멤버를 식별할 표시명(별명) 저장소.
 */
export class DiscordGuildMemberService {
  /**
   * @desc 로그인/길드 조회 시점에 받은 길드별 nick을 upsert (member, guild 당 1행)
   * - nick이 실제로 바뀐 경우에만 UPDATE (불필요한 write 방지).
   * - nickname이 없는 항목(undefined/null)은 제외 — enrichWithNick 성공 시 nick은 항상 문자열
   *   (username fallback)이므로 undefined는 "조회 실패(429/timeout)"만 의미. 실패값으로
   *   기존 저장 별명을 NULL로 덮어쓰면 일시 장애가 영구 데이터 유실이 되므로 스킵한다.
   * - 별명은 부가정보라 저장 실패가 상위 흐름(길드 조회)을 깨지 않도록 best-effort 처리.
   */
  public async upsertGuildNicknames(
    memberId: string,
    entries: { guildId: string; nickname: string | null | undefined }[],
  ): Promise<void> {
    const validEntries = entries.filter(
      (e): e is { guildId: string; nickname: string } => typeof e.nickname === 'string',
    );
    if (validEntries.length === 0) return;

    try {
      await db
        .insert(discordGuildMember)
        .values(
          validEntries.map((e) => ({
            memberId,
            guildId: e.guildId,
            nickname: e.nickname,
          })),
        )
        .onConflictDoUpdate({
          target: [discordGuildMember.memberId, discordGuildMember.guildId],
          set: {
            nickname: sql`excluded.nickname`,
            updateDate: new Date(),
          },
          where: sql`${discordGuildMember.nickname} IS DISTINCT FROM excluded.nickname`,
        });
    } catch (error) {
      // 별명은 부가정보 → 저장 실패해도 길드 조회 흐름은 진행. 추적 위해 로깅만.
      console.warn(`upsertGuildNicknames failed (member ${memberId})`, error);
    }
  }
}

export const discordGuildMemberService = new DiscordGuildMemberService();
