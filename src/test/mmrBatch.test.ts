import { jest, describe, test, expect } from '@jest/globals';

class ReachedDatabase extends Error {}

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: {
    select: () => {
      throw new ReachedDatabase();
    },
  },
  getClient: async () => ({
    query: async () => ({ rows: [{ locked: true }] }),
    release: () => undefined,
  }),
}));

const { chunk, seedMmrBatchWatermark, toSourceRow } = await import(
  '../services/mmr/mmrBatch.service.js'
);
const { invalidMatchReason } = await import('../services/mmr/mmrFeatures.js');
const { MmrPreconditionError, parseBaselineRow } = await import('../services/mmr/mmrBaseline.js');
const { buildPositionReports, buildSummaries, REPORT_METRICS } = await import(
  '../services/mmr/mmrAggregate.js'
);

describe('실수 반올림 경계 (gmok_mmr과 같은 값)', () => {
  // 승률은 wins / games * 100 순서다. wins * 100 / games로 바꾸면 160판 배수에서 0.01 갈린다.
  test.each([
    [23, 14.37],
    [49, 30.63],
  ])('160판 중 %i승 → %d', (wins, expected) => {
    const rows = Array.from({ length: 160 }, (_, i) => ({
      player_code: 'P1',
      position: 'TOP',
      game_result: i < wins ? 1 : 0,
      played_at: new Date(1_800_000_000_000 + i * 1000),
      replay_code: `R${i}`,
      pos_cumulative_mmr: 1300,
      total_mmr: 1300,
    }));
    const [summary] = buildSummaries(rows);
    expect(summary.overall_winrate).toBe(expected);
    expect(summary.top_winrate).toBe(expected);
  });

  test('position_report 안 실수도 pandas 방식이다(0.025 → 0.02)', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      player_code: 'P1',
      position: 'TOP',
      ...Object.fromEntries(REPORT_METRICS.map((metric) => [metric, 0])),
      kda: i === 0 ? 1 : 0,
    })) as unknown as Parameters<typeof buildPositionReports>[0];
    expect(buildPositionReports(rows).get('P1')?.TOP.kda).toBe(0.02);
  });
});

describe('결과 upsert 분할', () => {
  test('한 문장의 바인드 파라미터 상한(65535)을 넘지 않게 나눈다', () => {
    const parts = chunk(
      Array.from({ length: 1601 }, (_, i) => i),
      500,
    );
    expect(parts.map((part) => part.length)).toEqual([500, 500, 500, 101]);
    // 결과 행은 43개 파라미터를 쓴다
    expect(500 * 43).toBeLessThan(65535);
  });
});

describe('node-pg 행 변환', () => {
  const pgRow = {
    guild_id: 'g1',
    replay_code: 'RPY-1',
    player_code: 'PLR_1',
    champion_id: null,
    team: 'blue',
    position: 'TOP',
    game_result: 1,
    // extract(epoch)*1000은 numeric 문자열로 온다
    played_at_ms: '1795000000123.456000',
    kills: 3,
    deaths: null,
    game_duration: 1800,
  };

  test('numeric 문자열·NULL을 숫자·null로 바꾼다', () => {
    const row = toSourceRow(pgRow, '2026');
    expect(row.played_at.getTime()).toBe(1795000000123);
    expect(row.kills).toBe(3);
    expect(row.deaths).toBeNull();
    expect(row.assists).toBeNull();
  });

  test('계정이 NULL이면 "null" 문자열이 아니라 빈 값으로 두어 5v5 검증에서 걸린다', () => {
    const row = toSourceRow({ ...pgRow, player_code: null }, '2026');
    expect(row.player_code).toBe('');
    const match = Array.from({ length: 10 }, (_, i) => ({
      ...row,
      player_code: i === 0 ? '' : `P${i}`,
      position: ['TOP', 'JUG', 'MID', 'ADC', 'SUP'][i % 5],
      game_result: i < 5 ? 1 : 0,
    }));
    expect(invalidMatchReason(match)).toBe('missing identifier');
  });
});

describe('baseline 검증', () => {
  const positions = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'];
  const valid = {
    id: 1,
    season: '2026',
    baselineVersion: 'v1',
    metadata: { scope: 'all_guilds', match_count: 300 },
    mmrBaseline: {
      f1_mean: 1.01,
      f2_mean: 49.8,
      f1_position_mean: Object.fromEntries(positions.map((p) => [p, 1.0])),
      f2_position_mean: Object.fromEntries(positions.map((p) => [p, 50.0])),
    },
    gameImpactBaseline: {
      position_weights: Object.fromEntries(positions.map((p) => [p, { kills: 0.4, dpm: 0.6 }])),
      outcome_stats: positions.flatMap((p) =>
        [0, 1].map((r) => ({ position: p, game_result: r, lower: -100, upper: 900 })),
      ),
      impact_range: { lower: -300, upper: 4000 },
    },
  };

  test('정상 baseline은 통과한다', () => {
    expect(parseBaselineRow(valid).baselineVersion).toBe('v1');
  });

  test.each([
    ['scope가 all_guilds가 아님', { ...valid, metadata: { match_count: 300 } }],
    ['경기 수 200 미만', { ...valid, metadata: { scope: 'all_guilds', match_count: 120 } }],
    [
      'outcome_stats 누락',
      { ...valid, gameImpactBaseline: { ...valid.gameImpactBaseline, outcome_stats: [] } },
    ],
    [
      'impact_range 없음',
      {
        ...valid,
        gameImpactBaseline: { ...valid.gameImpactBaseline, impact_range: undefined },
      },
    ],
    ['f2_mean이 0', { ...valid, mmrBaseline: { ...valid.mmrBaseline, f2_mean: 0 } }],
  ])('%s이면 배치를 멈춘다', (_, row) => {
    expect(() => parseBaselineRow(row)).toThrow(MmrPreconditionError);
  });
});

describe('seed 시점 검증', () => {
  // C = 2026-11-21 06:00 KST
  const C = new Date('2026-11-20T21:00:00Z');

  test('C가 06:00 KST가 아니면 거부한다', async () => {
    await expect(
      seedMmrBatchWatermark(new Date('2026-11-20T22:00:00Z'), new Date('2026-11-22T00:00:00Z')),
    ).rejects.toThrow('not a 06:00 KST cutoff');
  });

  test('삭제 마감 + 10분(10:10 KST) 전에는 거부한다', async () => {
    await expect(seedMmrBatchWatermark(C, new Date('2026-11-21T01:09:59Z'))).rejects.toThrow(
      'still within the replay delete window',
    );
  });

  test('10:10 KST부터는 시점 검증을 넘어 DB 검증으로 간다', async () => {
    await expect(seedMmrBatchWatermark(C, new Date('2026-11-21T01:10:00Z'))).rejects.toBeInstanceOf(
      ReachedDatabase,
    );
  });
});
