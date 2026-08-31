import { describe, test, expect } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { periodCondition } from '../database/datePeriod.js';
import { customMatch } from '../database/schema.js';

const dialect = new PgDialect();
const query = (condition: SQL | undefined) => dialect.sqlToQuery(condition as SQL);

describe('periodCondition — 조회 기간 → WHERE 조각', () => {
  test('season은 날짜 조건이 없다 (시즌 조건이 따로 걸린다)', () => {
    expect(periodCondition(customMatch.createDate, 'season')).toBeUndefined();
  });

  test('recent는 최근 1개월 경계를 만든다', () => {
    expect(query(periodCondition(customMatch.createDate, 'recent')).sql).toBe(
      `"custom_match"."create_date" >= NOW() - INTERVAL '1 month'`,
    );
  });

  test('range는 월 범위를 and로 묶는다', () => {
    const { sql, params } = query(periodCondition(customMatch.createDate, 'range', '1', '4'));
    expect(sql).toContain('EXTRACT(MONTH FROM "custom_match"."create_date")');
    expect(sql).toContain(' and ');
    expect(params).toEqual([1, 4]);
  });

  test('연말을 걸치는 범위(11~2월)는 or로 묶는다 — and면 한 건도 안 나온다', () => {
    const { sql, params } = query(periodCondition(customMatch.createDate, 'range', '11', '2'));
    expect(sql).toContain(' or ');
    expect(sql).not.toContain(' and ');
    expect(params).toEqual([11, 2]);
  });

  test('range인데 월이 빠지면 최근 1개월로 떨어진다', () => {
    expect(query(periodCondition(customMatch.createDate, 'range')).sql).toBe(
      query(periodCondition(customMatch.createDate, 'recent')).sql,
    );
  });
});
