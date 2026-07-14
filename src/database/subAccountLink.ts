import { and, eq, sql, SQL } from 'drizzle-orm';
import { AnyPgColumn, alias } from 'drizzle-orm/pg-core';
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
 *     .where(eq(link.effectivePlayerCode, mePlayerCode));
 *
 * 같은 쿼리에서 두 참가자를 각각 매핑하면(alias 조인 등) aliasName 을 다르게 준다.
 */
export function subAccountLink(aliasName: string, guildId: string, playerCode: AnyPgColumn) {
  const table = alias(guildMember, aliasName);
  const on = and(
    eq(table.guildId, guildId),
    eq(table.account, playerCode),
    eq(table.isMain, false),
    eq(table.isDeleted, false),
  ) as SQL;
  const effectivePlayerCode = sql<string>`COALESCE(${table.mainAccount}, ${playerCode})`;
  return { table, on, effectivePlayerCode };
}
