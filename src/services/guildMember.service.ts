import { eq, desc, sql, and, or, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, TransactionType } from '../database/connectionPool.js';
import {
  guildMember,
  InsertGuildMember,
  matchParticipant,
  riotAccount,
  RiotAccount,
} from '../database/schema.js';
import { GetGuildMemberQuery, LinkSubAccountRequest } from '../types/guildMember.js';
import { BusinessError, SystemError } from '../types/error.js';
import { riotAccountService } from '../services/riotAccount.service.js';

export const primaryRiotAccount = alias(riotAccount, 'primary_riot_account');

/**
 * @desc 길드 멤버 서비스 클래스
 */
export class GuildMemberService {
  /**
   * @desc LIKE 검색 패턴 이스케이프 처리
   * %, _, \ 문자를 이스케이프하여 와일드카드 주입 방지
   */
  private escapeLikePattern(input: string): string {
    return input.replace(/[%_\\]/g, '\\$&');
  }

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
        .where(and(eq(guildMember.guildId, guildId), inArray(guildMember.account, playerCodes)));

      // 조회된 멤버를 Set으로 변환 (빠른 검색용)
      const existingAccountSet = new Set(existingMembers.map((m) => m.account));

      // 3. Filter: DB에 없는 멤버만 필터링
      const finalMembersToInsert: InsertGuildMember[] = riotAccounts
        .filter((acc) => !existingAccountSet.has(acc.playerCode))
        .map((acc) => ({
          guildId,
          account: acc.playerCode,
          isMain: true,
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
      eq(guildMember.status, '1'),
      eq(guildMember.isDeleted, false),
      eq(riotAccount.riotName, riotName),
    ];

    if (riotNameTag) {
      conditions.push(eq(riotAccount.riotNameTag, riotNameTag));
    }

    const result = await db
      .select({
        playerCode: riotAccount.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        isMain: guildMember.isMain,
        guildId: guildMember.guildId,
        createDate: guildMember.createDate,
        updateDate: guildMember.updateDate,
        isDeleted: guildMember.isDeleted,
      })
      .from(guildMember)
      .innerJoin(riotAccount, eq(guildMember.account, riotAccount.playerCode))
      .where(and(...conditions));

    return result;
  }

  /**
   * @desc 비슷한 계정 검색
   * 1. 대소문자 제거 2. 띄어쓰기, 공백 제거
   * [Security] LIKE 패턴 이스케이프 적용
   */
  private async findSimilarGuildMember(
    guildId: string,
    { riotName, riotNameTag, limit = 20 }: GetGuildMemberQuery,
  ) {
    const cleanName = riotName.replace(/\s+/g, '').toLowerCase();
    const escapedName = this.escapeLikePattern(cleanName);
    const searchPattern = `%${escapedName}%`;

    const conditions = [
      eq(guildMember.guildId, guildId),
      eq(guildMember.isMain, true),
      eq(guildMember.status, '1'),
      eq(guildMember.isDeleted, false),
      sql`LOWER(REPLACE(${riotAccount.riotName}, ' ', '')) LIKE ${searchPattern}`,
    ];

    if (riotNameTag) {
      const escapedTag = this.escapeLikePattern(riotNameTag.toLowerCase());
      conditions.push(sql`LOWER(${riotAccount.riotNameTag}) LIKE ${escapedTag}`);
    }

    const result = await db
      .select({
        playerCode: riotAccount.playerCode,
        riotName: riotAccount.riotName,
        riotNameTag: riotAccount.riotNameTag,
        isMain: guildMember.isMain,
        guildId: guildMember.guildId,
        createDate: guildMember.createDate,
        updateDate: guildMember.updateDate,
        isDeleted: guildMember.isDeleted,
      })
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
   * 2. 부계정이 이미 다른 본계정의 부계정인지 확인
   * 3. 본계정이 이미 다른 본계정의 부계정인지 확인
   * 4. 부계정 is_main, main_account 업데이트
   * 5. 부계정 경기 기록 player_code 본계정으로 변경
   */
  public async linkSubAccount({
    guildId,
    subRiotName,
    subRiotTag,
    mainRiotName,
    mainRiotTag,
  }: LinkSubAccountRequest) {
    return db.transaction(async (tx) => {
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
        throw new BusinessError('Primary or Secondary Riot Account not found in DB.', 400, {
          isLoggable: false,
        });
      }

      if (priRiot.playerCode === secRiot.playerCode) {
        throw new BusinessError('Cannot link the same account.', 400, {
          isLoggable: false,
        });
      }

      // 2. 부계정 GuildMember 엔티티 조회 (업데이트 대상)
      const secMember = await tx.query.guildMember.findFirst({
        where: and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.account, secRiot.playerCode), // 부계정의 playerCode 사용
          eq(guildMember.isDeleted, false),
        ),
      });

      if (!secMember) {
        throw new BusinessError(
          `${secRiot.riotName} account is not registered in this guild.`,
          400,
          { isLoggable: false },
        );
      }

      if (secMember.isMain === false) {
        throw new BusinessError(`${secRiot.riotName} is already linked as a sub-account.`, 409, {
          isLoggable: false,
        });
      }

      const priMember = await tx.query.guildMember.findFirst({
        where: and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.account, priRiot.playerCode),
          eq(guildMember.isDeleted, false),
        ),
      });

      if (!priMember) {
        throw new BusinessError(`${priRiot.riotName} is not registered in this guild.`, 400, {
          isLoggable: false,
        });
      }

      // 본캐가 이미 다른 사람의 부캐임 (계층 구조 방지)
      if (priMember.isMain === false) {
        throw new BusinessError(
          `${priRiot.riotName} is already a sub-account. (Cannot nest accounts)`,
          409,
          { isLoggable: false },
        );
      }

      // 3. GuildMember 테이블 업데이트
      const result = await tx
        .update(guildMember)
        .set({
          isMain: false,
          mainAccount: priRiot.playerCode,
          updateDate: new Date(),
        })
        .where(eq(guildMember.id, secMember.id))
        .returning();

      // 4. MatchParticipant 테이블 업데이트 (playerCode 변경)
      await tx
        .update(matchParticipant)
        .set({
          playerCode: priRiot.playerCode,
          updateDate: new Date(),
        })
        .where(eq(matchParticipant.playerCode, secRiot.playerCode));

      return result[0];
    });
  }

  /**
   * @desc 특정 길드의 모든 부계정 목록 조회
   */
  public async findSubAccountsByGuildId(guildId: string) {
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
          eq(guildMember.status, '1'),
        ),
      )
      .orderBy(desc(guildMember.id));
    return result;
  }

  /**
   * @desc 참여자 목록 중 부캐인 경우 본캐 정보 조회
   */
  public async findMainAccountsForSubMembers(
    playerCodes: string[],
    guildId: string,
    tx: TransactionType,
  ) {
    return tx
      .select({
        account: guildMember.account,
        mainAccount: guildMember.mainAccount,
      })
      .from(guildMember)
      .where(
        and(
          eq(guildMember.guildId, guildId),
          inArray(guildMember.account, playerCodes), // 참여자 목록에 있고
          eq(guildMember.isMain, false), // 부캐이며
          eq(guildMember.isDeleted, false), // 삭제되지 않은 멤버
        ),
      );
  }

  /**
   * @desc GuildMember 복귀, 탈퇴 업데이트
   */
  public async updateGuildMemberStatusByRiotId(
    guildId: string,
    riotName: string,
    riotNameTag: string,
    status: '1' | '2',
  ) {
    // 계정 찾기
    const [targetAccount] = await db
      .select({ playerCode: riotAccount.playerCode })
      .from(riotAccount)
      .where(and(eq(riotAccount.riotName, riotName), eq(riotAccount.riotNameTag, riotNameTag)))
      .limit(1);

    if (!targetAccount) {
      throw new BusinessError('Riot Account not found', 404);
    }

    const targetPlayerCode = targetAccount.playerCode;

    const result = await db
      .update(guildMember)
      .set({ status, updateDate: new Date() })
      .where(
        and(
          eq(guildMember.guildId, guildId),
          or(
            eq(guildMember.account, targetPlayerCode), // 본인
            eq(guildMember.mainAccount, targetPlayerCode), // 딸린 부캐들
          ),
        ),
      )
      .returning();

    return result;
  }

  /**
   * @desc 닉네임/태그로 부계정을 찾아 본계정 연동 해제
   */
  public async deleteSubAccountByRiotId(guildId: string, riotName: string, riotNameTag: string) {
    const [targetAccount] = await db
      .select({ playerCode: riotAccount.playerCode })
      .from(riotAccount)
      .where(and(eq(riotAccount.riotName, riotName), eq(riotAccount.riotNameTag, riotNameTag)))
      .limit(1);

    if (!targetAccount) {
      return null;
    }

    const result = await db
      .update(guildMember)
      .set({
        isMain: true,
        mainAccount: null,
        updateDate: new Date(),
      })
      .where(
        and(
          eq(guildMember.guildId, guildId),
          eq(guildMember.isMain, false),
          eq(guildMember.account, targetAccount.playerCode),
        ),
      )
      .returning();

    return result[0];
  }
}

export const guildMemberService = new GuildMemberService();
