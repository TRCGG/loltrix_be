import { eq, and, like, desc, sql } from 'drizzle-orm';
import { db, TransactionType  } from '../database/connectionPool.js';
import { riotAccount, InsertRiotAccount } from '../database/schema.js';
import { BusinessError, SystemError } from '../types/error.js';

export interface riotAccountData {
  PUUID: string;
  RIOT_ID_GAME_NAME: string;
  RIOT_ID_TAG_LINE: string;
};

/**
 * @desc Riot 계정 서비스
 */
export class RiotAccountService {
  constructor() {}

  /**
   * @desc 라이엇계정 기존 puuid 가 있으면 update // 없으면 insert
   * 트랜잭션
   */
  public async upsertRiotAccount(rawDatas: riotAccountData[], tx: TransactionType) {
    const RiotAccountData = await this.parsedRawData(rawDatas);

    try {
      const result = await tx
        .insert(riotAccount)
        .values(RiotAccountData)
        .onConflictDoUpdate({
          target: riotAccount.id,
          set: {
            riotName: riotAccount.riotName,
            riotNameTag: riotAccount.riotNameTag,
            updateDate: new Date(),
          },
        })
        .returning();

      return result;
    } catch (error) {
      console.error('Error upserting RiotAccount', error);
      throw new SystemError('RiotAccount error while upserting', 500);
    }
  }

  /**
   * @desc rawdataes 에서 riotaccount 추출
   */
  private async parsedRawData(rawDataes: riotAccountData[]): Promise<InsertRiotAccount[]> {
    const parsedRiotAccounts: InsertRiotAccount[] = [];

    for(const rawData of rawDataes) {
      const puuid = rawData.PUUID;
      const riotName = rawData.RIOT_ID_GAME_NAME;
      const riotNameTag = rawData.RIOT_ID_TAG_LINE;

      parsedRiotAccounts.push({
        id: puuid,
        riotName: riotName,
        riotNameTag: riotNameTag
      });
    }
    return parsedRiotAccounts;
  }
}

export const riotAccountService = new RiotAccountService();