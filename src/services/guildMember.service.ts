import { eq, ilike, desc, sql, and } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, TransactionType } from '../database/connectionPool.js';
import { guildMember, InsertGuildMember, matchParticipant, riotAccount, RiotAccount } from '../database/schema.js';
import { 
  GetGuildMemberQuery,
  LinkSubAccountRequest,
 } from '../types/guildMember.js';
import { BusinessError, SystemError } from '../types/error.js';
import { riotAccountService } from '../services/riotAccount.service.js';

export const primaryRiotAccount = alias(riotAccount, 'primary_riot_account');

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
    { riotName, riotNameTag, limit = 20 }: GetGuildMemberQuery,
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

  /**
   *
   * @desc 부계정 본계정 연결 (!부캐저장)
   * 1. 부계정 조회, 본계정 조회
   * 2. 부계정 is_main, main_account 업데이트
   * 3. 부계정 경기 기록 player_code 본계정으로 변경
   */
  public async linkSubAccount({
    guildId,
    subRiotName,
    subRiotTag,
    mainRiotName,
    mainRiotTag,
  }: LinkSubAccountRequest) {
    return await db.transaction(async (tx) => {
      // 1. 본계정 및 부계정 RiotAccount 존재 확인 (DB에서 playerCode, puuid 추출)
      const [priRiot, secRiot] = await Promise.all([
        // 본계정 조회
        riotAccountService.findAccountByRiotId(
          { riotName: mainRiotName, riotNameTag: mainRiotTag },
          tx,
        ),
        // 부계정 조회
        riotAccountService.findAccountByRiotId(
          { riotName: subRiotName, riotNameTag: subRiotTag },
          tx,
        ),
      ]);

      if (!priRiot || !secRiot) {
        throw new BusinessError('Primary or Secondary Riot Account not found in DB.', 404);
      }

      // 2. 부계정 GuildMember 엔티티 조회 (업데이트 대상)
      const secMember = await tx.query.guildMember.findFirst({
        where: and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.account, secRiot.playerCode), // 부계정의 playerCode 사용
        ),
      });

      if (!secMember) {
        throw new BusinessError(
          'Secondary account is not registered as a member in this guild.',
          403,
        );
      }

      // 3. GuildMember 테이블 업데이트
      const result = await tx
        .update(guildMember)
        .set({
          isMain: false,
          mainAccount: priRiot.playerCode,
        })
        .where(eq(guildMember.id, secMember.id))
        .returning();

      // 4. MatchParticipant 테이블 업데이트 (playerCode 변경)
      await tx
        .update(matchParticipant)
        .set({
          playerCode: priRiot.playerCode,
        })
        .where(eq(matchParticipant.playerCode, secRiot.playerCode));

      return result[0];
    });
  }

  /**
   * @desc 특정 길드의 모든 부계정 목록 조회
   */
  public async getSubAccountsByGuildId(guildId: string) {
    const result = await db
      .select({
        guildId: guildMember.guildId,

        subRiotName: riotAccount.riotName,
        subRiotNameTag: riotAccount.riotNameTag,

        mainRiotName: primaryRiotAccount.riotName,
        mainRiotNameTag: primaryRiotAccount.riotNameTag,
      })
      .from(guildMember)
      .innerJoin(riotAccount, eq(guildMember.account, riotAccount.playerCode))

      .leftJoin(primaryRiotAccount, eq(guildMember.mainAccount, primaryRiotAccount.playerCode))
      .where(
        and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.isMain, false),
          eq(guildMember.isDeleted, false),
        ),
      )
      .orderBy(desc(guildMember.id));
    return result;
  }
}

export const guildMemberService = new GuildMemberService();
