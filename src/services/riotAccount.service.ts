import { z } from 'zod';
import { eq, and, like, desc, sql, is, inArray} from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { riotAccount, InsertRiotAccount } from '../database/schema.js';
import { BusinessError, SystemError } from '../types/error.js';

const RiotAccountDataSchema = z.object({
  PUUID: z.string().min(1, 'PUUID는 필수 항목입니다.'),
  RIOT_ID_GAME_NAME: z.string().min(1, 'RIOT_ID_GAME_NAME은 필수 항목입니다.'),
  RIOT_ID_TAG_LINE: z.string().min(1, 'RIOT_ID_TAG_LINE은 필수 항목입니다.'),
});

const RiotAccountDataArraySchema = z.array(RiotAccountDataSchema);

/**
 * @desc Riot 계정 서비스
 */
export class RiotAccountService {
  constructor() {}

  /**
   * @desc 라이엇계정 기존 puuid 가 있으면 update // 없으면 insert
   * 트랜잭션
   */
  public async upsertRiotAccount(rawData: any[], tx: TransactionType) {
    try {
      const riotAccountDataList = this.parsedRawData(rawData);
      const results = [];

      for (const data of riotAccountDataList) {
        // 1. Select: 기존 계정 조회
        const [existingAccount] = await tx
          .select()
          .from(riotAccount)
          .where(eq(riotAccount.puuid, data.puuid));

        if (existingAccount) {
          // 2. Update: 기존 계정이 있고, 정보가 변경된 경우에만 수행
          if (
            existingAccount.riotName !== data.riotName ||
            existingAccount.riotNameTag !== data.riotNameTag
          ) {
            const [updated] = await tx
              .update(riotAccount)
              .set({
                riotName: data.riotName,
                riotNameTag: data.riotNameTag,
                updateDate: new Date(),
              })
              .where(eq(riotAccount.puuid, data.puuid))
              .returning();
            results.push(updated);
          } else {
            results.push(existingAccount); 
          }
        } else {
          // 3. Insert: 계정이 없을 때만 수행 (시퀀스 증가)
          const [inserted] = await tx.insert(riotAccount).values(data).returning();
          results.push(inserted);
        }
      }

      return results;
    } catch (error) {
      console.error('Error upserting RiotAccount', error);
      throw new SystemError('RiotAccount error while upserting', 500);
    }
  }

  /**
   *
   * @desc RiotAccount player_code 조회
   * rawData puuid로 player_code 조회
   * 트랜잭션
   */
  public async findRiotAccountsByPuuids(rawData: any[], tx: TransactionType) {
    const riotAccountDatas = this.parsedRawData(rawData);

    const puuids = riotAccountDatas.map((account) => account.puuid);

    try {
      const result = await tx.select().from(riotAccount).where(inArray(riotAccount.puuid, puuids));

      return result;
    } catch (error) {
      console.error('error while findRiotAccountsByPuuids');
      throw new SystemError('RiotAccount error while findRiotAccountsByPuuids', 500);
    }
  }

  /**
   * @desc RiotName과 RiotNameTag으로 RiotAccount를 조회
   */
  public async findAccountByRiotId(
    { riotName, riotNameTag }: { riotName: string; riotNameTag: string },
    tx: TransactionType,
  ) {
    return await tx.query.riotAccount.findFirst({
      where: 
      and(eq(riotAccount.riotName, riotName), 
      eq(riotAccount.riotNameTag, riotNameTag)),
    });
  }

  /**
   * @desc rawData 에서 riotAccount 추출 및 Zod 유효성 검사
   */
  private parsedRawData(rawData: any): InsertRiotAccount[] {
    const validatedData = RiotAccountDataArraySchema.parse(rawData);

    const parsedRiotAccounts: InsertRiotAccount[] = validatedData.map((d) => ({
      puuid: d.PUUID,
      riotName: d.RIOT_ID_GAME_NAME,
      riotNameTag: d.RIOT_ID_TAG_LINE,
    }));

    return parsedRiotAccounts;
  }
}

export const riotAccountService = new RiotAccountService();
