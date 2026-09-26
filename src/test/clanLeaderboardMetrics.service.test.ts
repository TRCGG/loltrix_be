import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const execute = jest.fn<(...args: SQL[]) => Promise<{ rows: unknown[] }>>();
const getConfigOrDefault = jest.fn(async (_key: string, _fallback: string) => '2026');
jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: { getConfigOrDefault },
}));

const { ClanLeaderboardMetricsService } = await import('../services/clanLeaderboardMetrics.service.js');
const service = new ClanLeaderboardMetricsService();
const dialect = new PgDialect();
const query = () => dialect.sqlToQuery(execute.mock.calls[0][0]);

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [] });
});

describe('new clan metrics SQL scope', () => {
  test('rising stars compare [now-60, now-30) and [now-30, now], require ten each, sort raw delta', async () => {
    expect(await service.getRisingStars('guild-one')).toEqual([]);
    const { sql: text, params } = query();
    expect(text).toContain('INTERVAL \'1 day\'');
    expect(params).toEqual(expect.arrayContaining([60, 'guild-one', '2026', '1']));
    expect(text).toContain("registered_at >= NOW() - INTERVAL '30 days'");
    expect(text).toContain("registered_at < NOW() - INTERVAL '30 days'");
    expect(text).toContain('current_count >= 10 AND previous_count >= 10');
    expect(text).toContain('WHERE delta > 0');
    expect(text).toContain('ORDER BY delta DESC, current_count DESC, player_code ASC LIMIT 5');
    expect(text).toContain('"guild_member"."is_main" =');
    expect(text).toContain('"custom_match"."season" =');
    expect(getConfigOrDefault).toHaveBeenCalledWith('LOL_SEASON', 'error_season');
  });

  test('highlights keep tied game entries and multi-pentakill values from a single query', async () => {
    const tied = [
      {
        playerCode: 'one', riotName: 'A', riotNameTag: 'KR1',
        champion: { champName: '아리', champNameEng: 'Ahri' },
        registeredDate: '2026-09-01', value: 20,
      },
      {
        playerCode: 'one', riotName: 'A', riotNameTag: 'KR1',
        champion: { champName: '아리', champNameEng: 'Ahri' },
        registeredDate: '2026-09-02', value: 20,
      },
    ];
    execute.mockResolvedValue({
      rows: [{
        records: { kills: { value: 20, entries: tied } },
        pentakills: { totalPlayers: 1, totalPentaKills: 2, entries: [{ pentaKills: 2 }] },
      }],
    });
    const result = await service.getHighlights('guild-one', '2025');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.kills.entries).toEqual(tied);
    expect(result.assists).toEqual({ value: null, entries: [] });
    expect(result.pentakills).toMatchObject({ totalPlayers: 1, totalPentaKills: 2 });
    const { sql: text, params } = query();
    expect(params).toEqual(expect.arrayContaining([30, '2025']));
    expect(text).toContain('MAX(value)');
    expect(text).toContain('measurements.value = maxima.value');
    expect(text).toContain('COUNT(DISTINCT player_code)');
    expect(text).toContain('SUM(penta_kills)');
    expect(text).toContain('WHERE penta_kills > 0');
    expect(text).toContain('p.building_damage');
    expect(getConfigOrDefault).not.toHaveBeenCalled();
  });

  test('empty highlights return null records and zero pentakills', async () => {
    const result = await service.getHighlights('guild-one');
    expect(result.kills).toEqual({ value: null, entries: [] });
    expect(result.buildingDamage).toEqual({ value: null, entries: [] });
    expect(result.pentakills).toEqual({ totalPlayers: 0, totalPentaKills: 0, entries: [] });
  });

  test('current streak stops at the first non-win and uses deterministic registration order', async () => {
    expect(await service.getWinStreaks('guild-one')).toEqual([]);
    const { sql: text, params } = query();
    expect(params).toEqual(expect.arrayContaining([30]));
    expect(text).toContain("CASE WHEN result = '승' THEN 0 ELSE 1 END");
    expect(text).toContain('ORDER BY registered_at DESC, match_id DESC, participant_id DESC');
    expect(text).toContain("WHERE result = '승' AND losses_seen = 0");
    expect(text).toContain('HAVING COUNT(*) >= 2');
    expect(text).toContain('ORDER BY streak DESC, latest_registered_at DESC, player_code ASC LIMIT 5');
  });
});
