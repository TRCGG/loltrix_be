import { and, eq, inArray, isNotNull, sql, SQL } from 'drizzle-orm';
import { AnyPgColumn, alias } from 'drizzle-orm/pg-core';
import { db, DbOrTx } from './connectionPool.js';
import { guildMember } from './schema.js';

/**
 * @desc 부캐 → 본캐 유효 식별자(effective player_code) 매핑 헬퍼 (TRC-243 A안)
 *
 * match_participant / mmr_participant_metric 의 player_code 는 항상 "실제 계정" 코드다.
 * 계정 단위 집계·필터(전적, 통계, H2H)는 이 헬퍼로 guild_member 링크를 LEFT JOIN 해서
 * COALESCE(main_account, player_code) 를 식별자로 쓴다 — 링크된 부캐면 본캐 코드,
 * 아니면 본인 코드. 부캐 연결/해제는 guild_member 만 바꾸므로 조회 결과에 즉시 반영된다.
 *
 * 길드 스코프 조인이라 다른 길드의 링크는 영향을 주지 않는다 (커밋 82effd4 의도 유지).
 *
 * 사용 예:
 *   const link = subAccountLink('mp_link', guildId, matchParticipant.playerCode);
 *   db.select({ code: link.effectivePlayerCode })
 *     .from(matchParticipant)
 *     .leftJoin(link.table, link.on)
 *     .where(link.isPlayer(mePlayerCode));
 *
 * 같은 쿼리에서 두 참가자를 각각 매핑하면(alias 조인 등) aliasName 을 다르게 준다.
 */
export function subAccountLink(aliasName: string, guildId: string, playerCode: AnyPgColumn) {
  const table = alias(guildMember, aliasName);
  // 링크 행 판정은 on과 isPlayer가 이 조건을 함께 써야 둘의 결과가 같다.
  const linkRowOf = (t: { guildId: AnyPgColumn; isMain: AnyPgColumn; isDeleted: AnyPgColumn }) => [
    eq(t.guildId, guildId),
    eq(t.isMain, false),
    eq(t.isDeleted, false),
  ];
  const on = and(...linkRowOf(table), eq(table.account, playerCode)) as SQL;
  const effectivePlayerCode = sql<string>`COALESCE(${table.mainAccount}, ${playerCode})`;
  // effectivePlayerCode = target과 같은 행을 player_code 조건으로 바꿔 인덱스를 태운다.
  // (guild_id, account) 유니크로 계정당 링크가 하나라는 전제에서만 둘이 같다.
  // COALESCE 비교를 함께 걸면 선택도가 곱해져 과소추정되고, IN (서브쿼리)는 조인이 많은 쿼리에서
  // semi join이 맨 뒤로 밀려 전체를 읽는다. ARRAY()는 먼저 한 번 계산돼 인덱스 조건으로 쓰인다.
  const isPlayer = (target: string) =>
    sql`${playerCode} = ANY(ARRAY(
      SELECT ${guildMember.account} FROM ${guildMember}
      WHERE ${and(...linkRowOf(guildMember), eq(guildMember.mainAccount, target))}
      UNION ALL
      SELECT ${target} WHERE NOT EXISTS (
        SELECT 1 FROM ${guildMember}
        WHERE ${and(...linkRowOf(guildMember), eq(guildMember.account, target), isNotNull(guildMember.mainAccount))}
      )
    ))`;
  return { table, on, effectivePlayerCode, isPlayer };
}

/**
 * 조인이 아니라 행 단위로 본계정을 해석한다 (대회 로스터·신청 저장, 자동 배정 집계용).
 * subAccountLink와 같은 길드 스코프 규칙 — 링크되지 않은 코드는 자기 자신으로 매핑된다.
 */
export async function mainAccountMap(
  guildId: string,
  playerCodes: string[],
  executor: DbOrTx = db,
): Promise<Map<string, string>> {
  const map = new Map(playerCodes.map((code) => [code, code]));
  if (playerCodes.length === 0) return map;

  const rows = await executor
    .select({ account: guildMember.account, mainAccount: guildMember.mainAccount })
    .from(guildMember)
    .where(
      and(
        eq(guildMember.guildId, guildId),
        inArray(guildMember.account, [...new Set(playerCodes)]),
        eq(guildMember.isMain, false),
        eq(guildMember.isDeleted, false),
      ),
    );

  for (const row of rows) {
    if (row.mainAccount) map.set(row.account, row.mainAccount);
  }
  return map;
}
