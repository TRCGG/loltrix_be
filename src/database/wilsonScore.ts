import { sql, SQL } from 'drizzle-orm';

/**
 * 승률 순위에서 적은 판수의 전승 기록이 과대평가되지 않도록 95% 윌슨 신뢰구간 하한을 쓴다.
 * wins는 승수, total은 판수 집계식이며, 1.96은 z값, 3.8416은 z²이다.
 * 결과는 백분율이 아닌 0~1 척도의 정렬용 점수다. 판수가 0이면 0을 반환한다.
 */
export function wilsonScore(wins: SQL, total: SQL): SQL<number> {
  const n = sql`NULLIF((${total})::numeric, 0)`;
  const p = sql`(${wins})::numeric / ${n}`;
  return sql<number>`COALESCE(
    (${p} + 3.8416 / (2 * ${n})
      - 1.96 * SQRT((${p} * (1 - ${p}) + 3.8416 / (4 * ${n})) / ${n}))
    / (1 + 3.8416 / ${n}), 0)`.mapWith(Number);
}
