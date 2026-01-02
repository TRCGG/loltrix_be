import { TransactionType } from '../database/connectionPool.js';
import { customMatch, InsertCustomMatch } from '../database/schema.js';
import { SystemError } from '../types/error.js';

/**
 * @desc 내전 커스텀 게임정보
 *
 */
export class CustomMatchService {
  /**
   * @desc 새로운 내전 매치 데이터베이스에 저장
   */
  public async insertCustomMatch(newCustomMatchData: InsertCustomMatch, tx: TransactionType) {
    try {
      const result = await tx.insert(customMatch).values(newCustomMatchData).returning();
      return result[0];
    } catch (error) {
      console.error('Error inserting CustomMatch', error);
      throw new SystemError('CustomMatch error while inserting', 500);
    }
  }
}

export const customMatchService = new CustomMatchService();
