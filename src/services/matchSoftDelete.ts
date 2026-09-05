import { and, eq, inArray } from 'drizzle-orm';
import { TransactionType } from '../database/connectionPool.js';
import {
  competitionMatchTeam,
  customMatch,
  matchParticipant,
  mmrParticipantMetric,
  replay,
  CustomMatch,
} from '../database/schema.js';

/**
 * 경기 soft-delete 캐스케이드. !drop 한 건과 대회 삭제의 경기 동반 삭제가 이 함수를 공유한다 —
 * 갈라지면 한쪽 경로에만 전적·리플·팀 귀속이 살아남는다.
 *
 * custom_match를 먼저 뒤집고 **실제로 뒤집힌 행만** 캐스케이드한다. 다른 길드의 경기이거나
 * 이미 지워진 경기면 여기서 멈춰야 참가자·리플이 딸려 지워지지 않는다.
 */
export const softDeleteMatches = async (
  ids: string[],
  tx: TransactionType,
  guildId?: string,
): Promise<CustomMatch[]> => {
  if (ids.length === 0) return [];
  const updateDate = new Date();

  const deleted = await tx
    .update(customMatch)
    .set({ isDeleted: true, updateDate })
    .where(
      and(
        inArray(customMatch.id, ids),
        eq(customMatch.isDeleted, false),
        guildId ? eq(customMatch.guildId, guildId) : undefined,
      ),
    )
    .returning();
  if (deleted.length === 0) return deleted;

  const targets = deleted.map((match) => match.id);

  await tx
    .update(matchParticipant)
    .set({ isDeleted: true, updateDate })
    .where(
      and(inArray(matchParticipant.customMatchId, targets), eq(matchParticipant.isDeleted, false)),
    );

  // H2H가 지운 경기를 빼려면 지표도 같이 내려야 한다
  await tx
    .update(mmrParticipantMetric)
    .set({ isDeleted: true, updateDate })
    .where(
      and(
        inArray(mmrParticipantMetric.customMatchId, targets),
        eq(mmrParticipantMetric.isDeleted, false),
      ),
    );

  // replay_code = custom_match.id
  await tx
    .update(replay)
    .set({ isDeleted: true, updateDate })
    .where(and(inArray(replay.replayCode, targets), eq(replay.isDeleted, false)));

  // 귀속 행에는 soft-delete 컬럼이 없다. 대회 삭제 경로에선 용병전(team_id NULL) 행을 치우는
  // 유일한 지점이기도 하다 — 대회가 지워질 때 팀 cascade는 team_id가 있는 행만 걷어간다.
  await tx.delete(competitionMatchTeam).where(inArray(competitionMatchTeam.customMatchId, targets));

  return deleted;
};
