import { asc, eq } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { champion } from '../database/schema.js';
import { ChampionListItem } from '../types/champion.js';

/**
 * @desc 챔피언 서비스 클래스
 */
export class ChampionService {
  /**
   * @desc 삭제되지 않은 챔피언 전체 조회 (한글 이름순)
   */
  public async getAll(): Promise<ChampionListItem[]> {
    return db
      .select({
        id: champion.id,
        champName: champion.champName,
        champNameEng: champion.champNameEng,
        riotKey: champion.riotKey,
      })
      .from(champion)
      .where(eq(champion.isDeleted, false))
      .orderBy(asc(champion.champName), asc(champion.id));
  }
}

export const championService = new ChampionService();
