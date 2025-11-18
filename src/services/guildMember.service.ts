import { eq, ilike, desc, sql, and } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { guildMember, InsertGuildMember, riotAccount, RiotAccount } from '../database/schema.js';
import { GetGuildMemberQuery } from '../types/guildMember.js';
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
      guildId: guildId,
      account: acc.playerCode,
      isMain: true,
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
      console.error('Error inserting guild members', error);
      throw new SystemError('GuildMember error while inserting', 500);
    }
  }

  /**
   * @desc 정확히 일치하는 계정 검색
   */
  private async findExactGuildMember(
    guildId: string,
    { riotName, riotNameTag }: GetGuildMemberQuery,
  ) {
    const conditions = [
      eq(guildMember.guildId, guildId),
      eq(guildMember.isMain, true),
      eq(guildMember.isDeleted, false),
      eq(riotAccount.riotName, riotName),
    ];

    if (riotNameTag) {
      conditions.push(eq(riotAccount.riotNameTag, riotNameTag));
    }

    const result = await db
      .select()
      .from(guildMember)
      .innerJoin(riotAccount, eq(guildMember.account, riotAccount.playerCode))
      .where(and(...conditions));

    return result;
  }

  /**
   * @desc 비슷한 계정 검색
   * 1. 대소문자 제거 2. 띄어쓰기, 공백 제거
   */
  private async findSimilarGuildMember(
    guildId: string,
    { riotName, riotNameTag, limit=20 }: GetGuildMemberQuery,
  ) {
    const cleanName = riotName.replace(/\s+/g, '').toLowerCase();
    const searchPattern = `%${cleanName}%`;

    const conditions = [
      eq(guildMember.guildId, guildId),
      eq(guildMember.isMain, true),
      eq(guildMember.isDeleted, false),
      sql`LOWER(REPLACE(${riotAccount.riotName}, ' ', '')) LIKE ${searchPattern}`,
    ];

    if (riotNameTag) {
      conditions.push(sql`LOWER(${riotAccount.riotNameTag}) = LOWER(${riotNameTag})`);
    }

    const result = await db
      .select()
      .from(guildMember)
      .innerJoin(riotAccount, eq(guildMember.account, riotAccount.playerCode))
      .where(and(...conditions))
      .limit(limit);

    return result;
  }

  /**
   * @desc 계정 조회 API 
   * 1. 정확한 계정 검색 2. 비슷한 계정 검색
   */
  public async searchGuildMemberByRiotId(guildId: string, params: GetGuildMemberQuery) {
    const exactResult = await this.findExactGuildMember(guildId, params);

    if (exactResult.length > 0) {
      return exactResult;
    }

    const similarResult = await this.findSimilarGuildMember(guildId, params);
    return similarResult;
  }
}

export const guildMemberService = new GuildMemberService();
