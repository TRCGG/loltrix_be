import { eq, ilike, desc, sql, and } from 'drizzle-orm';
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
    const membersToInsert: InsertGuildMember[] = riotAccounts.map((acc) => ({
      guild_id: guildId,
      account: acc.playerCode,
      is_main: true,
      status: '1',
    }));

    try {
      const insertedMembers = await tx
        .insert(guildMember)
        .values(membersToInsert)
        .onConflictDoNothing()
        .returning();
      return insertedMembers;
    } catch (error) {
      console.error('Error upserting guild members', error);
      throw new SystemError('GuildMember error while upserting', 500);
    }
  }
}

export const guildMemberService = new GuildMemberService();
