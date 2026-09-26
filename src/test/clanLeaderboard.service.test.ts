import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const execute = jest.fn<(...args: SQL[]) => Promise<{ rows: unknown[] }>>();
const getConfigOrDefault = jest.fn(async (_key: string, _fallback: string) => '2026');
const getNumberConfig = jest.fn(async (_key: string, _fallback: number) => 5);
jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: { getConfigOrDefault, getNumberConfig },
}));
const { ClanLeaderboardService } = await import('../services/clanLeaderboard.service.js');
const service = new ClanLeaderboardService();
const dialect = new PgDialect();
const query = () => dialect.sqlToQuery(execute.mock.calls[0][0]);

beforeEach(() => {
  jest.clearAllMocks();
  getNumberConfig.mockResolvedValue(5);
  execute.mockResolvedValue({ rows: [{ result: [], totalCount: 0 }] });
});

describe('clan leaderboard scope', () => {
  test('uses registered date, normal matches, season and guild-specific main-account membership', async () => {
    await service.getDuos('guild-one');
    const { sql: text, params } = query();
    expect(text).toContain('"custom_match"."create_date" >= NOW() - INTERVAL \'30 days\'');
    expect(text).toContain('"custom_match"."game_type" =');
    expect(text).toContain('"custom_match"."guild_id" =');
    expect(text).toContain('"custom_match"."season" =');
    expect(text).toContain('"guild_member"."status" =');
    expect(text).toContain('"guild_member"."is_main" =');
    expect(text).toContain('"leaderboard_sub_link"."guild_id" =');
    expect(text).toContain(
      'COALESCE("leaderboard_sub_link"."main_account", "match_participant"."player_code")',
    );
    expect(params).toEqual(expect.arrayContaining(['guild-one', '1', '2026', false, true]));
    expect(getConfigOrDefault).toHaveBeenCalledWith('LOL_SEASON', 'error_season');
  });

  test('explicit season and wrapping month range use shared period semantics', async () => {
    await service.getDuos('guild-one', {
      season: '2025',
      datePreset: 'range',
      fromMonth: '11',
      toMonth: '2',
    });
    const { sql: text, params } = query();
    expect(text).toContain('EXTRACT(MONTH FROM "custom_match"."create_date")::integer');
    expect(text).toContain(' or ');
    expect(text).not.toContain('INTERVAL');
    expect(params).toEqual(expect.arrayContaining(['2025', 11, 2]));
    expect(getConfigOrDefault).not.toHaveBeenCalled();
  });

  test('whole season has no recent constraint', async () => {
    await service.getDuos('guild-one', { datePreset: 'season' });
    expect(query().sql).not.toContain('INTERVAL');
    expect(query().sql).not.toContain('EXTRACT(MONTH');
  });

  test.each(['recent', 'recent30'] as const)('%s uses the same 30-day match scope', async (datePreset) => {
    await service.getActivity('guild-one', { datePreset });
    expect(query().sql).toContain("INTERVAL '30 days'");
  });
});

describe('champion combinations', () => {
  test.each([
    ['ADCSUP', 'ADC', 'SUP'],
    ['MIDJUG', 'MID', 'JUG'],
  ] as const)(
    '%s counts team occurrences and unique unordered canonical pairs',
    async (combination, first, second) => {
      await service.getChampionCombinations('guild-one', { combination });
      const { sql: text, params } = query();
      expect(params).toEqual(expect.arrayContaining([first, second]));
      expect(text).toContain(
        'a.match_id = b.match_id AND a.team = b.team AND a.player_code <> b.player_code',
      );
      expect(text).toContain('COUNT(DISTINCT (a.match_id, a.team))');
      expect(text).toContain(
        'COUNT(DISTINCT (LEAST(a.player_code, b.player_code), GREATEST(a.player_code, b.player_code)))',
      );
      expect(text).toContain('"wilsonScore" DESC, "totalCount" DESC');
      expect(text).toContain('SQRT');
    },
  );

  test('minimum is fetched at runtime and applied before pagination', async () => {
    getNumberConfig.mockResolvedValue(7);
    await service.getChampionCombinations('guild-one', {
      combination: 'ADCSUP',
      page: 3,
      limit: 5,
    });
    const { sql: text, params } = query();
    expect(getNumberConfig).toHaveBeenCalledWith('STATS_MIN_GAME_COUNT', 10);
    expect(text).toContain('HAVING COUNT(DISTINCT (a.match_id, a.team)) >=');
    expect(params.slice(-3)).toEqual([7, 5, 10]);
  });
});

describe('duos and activity', () => {
  test('duos count unique games, exclude opponents/self and order by games without a minimum', async () => {
    await service.getDuos('guild-one');
    const { sql: text } = query();
    expect(text).toContain(
      'a.match_id = b.match_id AND a.team = b.team AND a.player_code < b.player_code',
    );
    expect(text).toContain('COUNT(DISTINCT a.match_id)');
    expect(text).toContain('"totalCount" DESC, players ASC');
    expect(text).not.toContain('HAVING');
    expect(getNumberConfig).not.toHaveBeenCalled();
  });

  test('empty page retains total rankings rather than deriving total from page size', async () => {
    execute.mockResolvedValue({ rows: [{ result: [], totalCount: 7 }] });
    expect(await service.getDuos('guild-one', { page: 99 })).toEqual({ result: [], totalCount: 7 });
    expect(query().sql).toContain('(SELECT COUNT(*)::integer FROM ranking) AS "totalCount"');
  });

  test('activity counts matches independently from participant joins and aggregates registered dates', async () => {
    const activity = {
      totalMatches: 2,
      totalPlayers: 10,
      dailyMatches: [{ date: '2026-09-13', matchCount: 2 }],
    };
    execute.mockResolvedValue({ rows: [activity] });
    expect(await service.getActivity('guild-one')).toEqual(activity);
    const { sql: text } = query();
    expect(text).toContain('(SELECT COUNT(*)::integer FROM scoped_matches) AS "totalMatches"');
    expect(text).toContain('COUNT(DISTINCT player_code)::integer FROM participants');
    expect(text).toContain("to_char(registered_at, 'YYYY-MM-DD')");
    expect(text).toContain('ORDER BY date');
    expect(text).not.toContain('HAVING');
  });

  test('activity has a stable empty response', async () => {
    execute.mockResolvedValue({ rows: [] });
    expect(await service.getActivity('guild-one')).toEqual({
      totalMatches: 0,
      totalPlayers: 0,
      dailyMatches: [],
    });
  });
});
