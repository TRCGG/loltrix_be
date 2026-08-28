import { and, eq } from 'drizzle-orm';
import { db, DbOrTx } from '../database/connectionPool.js';
import { competition } from '../database/schema.js';
import { BusinessError } from '../types/error.js';

export const COMPETITION_STATUS = { OPEN: 'OPEN', CLOSED: 'CLOSED' } as const;

export interface CompetitionRef {
  id: number;
  name: string;
}

export class CompetitionService {
  /**
   * 리플이 붙을 대회를 확정한다. 일반내전(1)은 대회 없음.
   * 스크림·본경기는 competitionId가 없으면 길드의 OPEN 대회로 해석한다.
   *
   * lock=true(저장 트랜잭션 안): FOR SHARE로 잡아 트랜잭션이 끝날 때까지 종료(UPDATE)가 못 끼어들게 한다.
   * 봇이 첨부 여러 개를 수십 초에 걸쳐 순차 저장하는 동안 !대회종료가 오면, 잠금이 없을 때
   * 뒤 파일이 닫힌 대회에 붙는다.
   */
  public async resolveForSave(
    guildId: string,
    gameType: string,
    competitionId: number | null | undefined,
    executor: DbOrTx = db,
    lock = false,
  ): Promise<CompetitionRef | null> {
    if (gameType === '1') return null;

    const condition =
      competitionId != null
        ? and(eq(competition.id, competitionId), eq(competition.guildId, guildId))
        : and(eq(competition.guildId, guildId), eq(competition.status, COMPETITION_STATUS.OPEN));

    const query = executor
      .select({ id: competition.id, name: competition.name, status: competition.status })
      .from(competition)
      .where(condition)
      .limit(1);
    const [row] = await (lock ? query.for('share') : query);

    if (!row) {
      if (competitionId != null) {
        throw new BusinessError('competition not found', 400, {
          type: 'competition-not-found',
          isLoggable: false,
        });
      }
      throw new BusinessError('no open competition', 400, {
        type: 'no-open-competition',
        isLoggable: false,
      });
    }
    if (row.status !== COMPETITION_STATUS.OPEN) {
      throw new BusinessError('competition is closed', 400, {
        type: 'competition-not-open',
        isLoggable: false,
      });
    }
    return { id: row.id, name: row.name };
  }
}

export const competitionService = new CompetitionService();
