import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const execute = jest.fn<(...args: SQL[]) => Promise<{ rows: unknown[] }>>();
jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: { execute } }));
const { SiteStatisticsService } = await import('../services/siteStatistics.service.js');
const service = new SiteStatisticsService();
const query = () => new PgDialect().sqlToQuery(execute.mock.calls[0][0]);

beforeEach(() => {
  execute.mockReset().mockResolvedValue({ rows: [{ clanCount: 0 }] });
});

describe('site overview scope', () => {
  test('삭제된 길드·경기·참가자는 빼고 비공개 길드는 포함한다', async () => {
    await service.getOverview();
    const { sql: text } = query();

    expect(text).toContain('"guild"."is_deleted" = false');
    expect(text).toContain('"custom_match"."is_deleted" = false');
    expect(text).toContain('"match_participant"."is_deleted" = false');
    expect(text).not.toContain('is_public');
  });

  test('클랜 수는 경기 기록과 무관하게 삭제되지 않은 길드를 모두 센다', async () => {
    await service.getOverview();
    const { sql: text } = query();

    expect(text).toContain(
      '(SELECT COUNT(*)::integer FROM "guild" WHERE "guild"."is_deleted" = false) AS "clanCount"',
    );
  });

  test('플레이어는 본캐로 묶지 않고 player_code 그대로 센다', async () => {
    await service.getOverview();
    const { sql: text } = query();

    expect(text).toContain('COUNT(DISTINCT "match_participant"."player_code")');
    expect(text).not.toContain('main_account');
  });

  test('최근 30일과 일반내전·대회(스크림·예선·본선) 구분을 쓴다', async () => {
    await service.getOverview();
    const { sql: text, params } = query();

    expect(text).toContain("create_date >= NOW() - INTERVAL '30 days'");
    expect(text).toContain('"custom_match"."game_type" = \'1\' AS is_normal');
    expect(text).toMatch(/"custom_match"\."game_type" in \(\$1, \$2, \$3\) AS is_competition/);
    expect(params).toEqual(['2', '3', '4']);
  });
});
