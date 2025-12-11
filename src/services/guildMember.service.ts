import { eq, and, inArray } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { guildMember, InsertGuildMember, RiotAccount } from '../database/schema.js';
import { BusinessError, SystemError } from '../types/error.js';

/**
 * @desc 길드 멤버 서비스 클래스
 */
export class GuildMemberService {
  constructor() {}

  /**
   * @desc 리플레이 참여 계정들을 길드 멤버로 등록
   * 'UNIQUE(guild_id, account)' 제약 조건에 따라
   * 이미 길드에 등록된 계정은 무시
   *
   */
  public async insertGuildMember(
    riotAccounts: RiotAccount[],
    guildId: string,
    tx: TransactionType,
  ) {
    try {
      // 1. 등록하려는 계정들의 playerCode 목록 추출
      const playerCodes = riotAccounts.map((acc) => acc.playerCode);
      if (playerCodes.length === 0) return [];

      // 2. Select: 이미 해당 길드에 존재하는 멤버 조회
      const existingMembers = await tx
        .select({ account: guildMember.account })
        .from(guildMember)
        .where(and(eq(guildMember.guild_id, guildId), inArray(guildMember.account, playerCodes)));

      // 조회된 멤버를 Set으로 변환 (빠른 검색용)
      const existingAccountSet = new Set(existingMembers.map((m) => m.account));

      // 3. Filter: DB에 없는 멤버만 필터링
      const finalMembersToInsert: InsertGuildMember[] = riotAccounts
        .filter((acc) => !existingAccountSet.has(acc.playerCode))
        .map((acc) => ({
          guild_id: guildId,
          account: acc.playerCode,
          is_main: true,
          status: '1',
        }));

      // 4. Insert: 필터링된 멤버가 있을 때만 저장
      if (finalMembersToInsert.length > 0) {
        const insertedMembers = await tx
          .insert(guildMember)
          .values(finalMembersToInsert)
          .returning();
        return insertedMembers;
      }

      return []; // 새로 추가된 멤버 없음
    } catch (error) {
      console.error('Error inserting guild members', error);
      throw new SystemError('GuildMember error while inserting', 500);
    }
  }
}

export const guildMemberService = new GuildMemberService();
