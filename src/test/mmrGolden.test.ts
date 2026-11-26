import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseBaselineRow } from '../services/mmr/mmrBaseline.js';
import {
  buildMatchFeatures,
  invalidMatchReason,
  MmrSourceRow,
} from '../services/mmr/mmrFeatures.js';
import { applyMatch, MmrResultRow, MmrState } from '../services/mmr/mmrFormula.js';
import {
  buildPositionReports,
  buildSummaries,
  compareByPlayedAt,
  toStoredResultRow,
} from '../services/mmr/mmrAggregate.js';

/**
 * gmok_mmr(Python)로 만든 정답과 TS 이식을 소수점까지 대조한다.
 * fixture 갱신: scripts/mmr/generate_golden_fixture.py
 */
type Json = Record<string, unknown>;
const fixture = JSON.parse(
  gunzipSync(readFileSync(new URL('./fixtures/mmrGolden.json.gz', import.meta.url))).toString(
    'utf-8',
  ),
) as {
  baseline: Json;
  source_rows: Json[];
  expected_results: Json[];
  expected_unrounded: Json[];
  expected_summary: Json[];
  expected_reports: Record<string, Json>;
};

const baseline = parseBaselineRow({
  id: fixture.baseline.id as number,
  season: fixture.baseline.season as string,
  baselineVersion: fixture.baseline.baseline_version as string,
  mmrBaseline: fixture.baseline.mmr_baseline,
  gameImpactBaseline: fixture.baseline.game_impact_baseline,
  metadata: fixture.baseline.metadata,
});

const sourceRows = fixture.source_rows.map(
  (row) => ({ ...row, played_at: new Date(row.played_at as string) }) as unknown as MmrSourceRow,
);

// 경기는 played_at·replay_code 순, 경기 안의 행은 fixture(=Python 입력) 순서 그대로 둔다
const matches = new Map<string, MmrSourceRow[]>();
for (const row of sourceRows) {
  const list = matches.get(row.replay_code) ?? [];
  list.push(row);
  matches.set(row.replay_code, list);
}
const orderedMatches = [...matches.values()].sort((a, b) => compareByPlayedAt(a[0], b[0]));

const state = new MmrState();
const results: MmrResultRow[] = [];
const skipped: string[] = [];
for (const rows of orderedMatches) {
  if (invalidMatchReason(rows)) {
    skipped.push(rows[0].replay_code);
    continue;
  }
  results.push(...applyMatch(buildMatchFeatures(rows, baseline), state, baseline));
}

const key = (row: object) => {
  const { replay_code: replayCode, player_code: playerCode } = row as Json;
  return `${String(replayCode)}/${String(playerCode)}`;
};

describe('gmok_mmr golden fixture 대조', () => {
  test('5v5 구조가 깨진 경기는 계산하지 않는다', () => {
    expect(skipped).toEqual(['RPY-0030']);
    expect(results).toHaveLength(fixture.expected_results.length);
  });

  test('저장되는 결과 행이 소수점까지 같다', () => {
    const actual = new Map(
      results.map((row) => [key(row), toStoredResultRow(row, baseline) as Json]),
    );
    const mismatches: string[] = [];
    for (const expected of fixture.expected_results) {
      const row = actual.get(key(expected));
      if (!row) {
        mismatches.push(`${key(expected)} missing`);
        continue;
      }
      for (const [column, value] of Object.entries(expected)) {
        const got = row[column] instanceof Date ? (row[column] as Date).toISOString() : row[column];
        const want = column === 'played_at' ? new Date(value as string).toISOString() : value;
        if (got !== want)
          mismatches.push(`${key(expected)} ${column}: ${String(got)} != ${String(want)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('반올림 전 실수도 같다', () => {
    const actual = new Map(results.map((row) => [key(row), row as unknown as Json]));
    const mismatches: string[] = [];
    for (const expected of fixture.expected_unrounded) {
      const row = actual.get(key(expected)) as Json;
      for (const [column, value] of Object.entries(expected)) {
        if (column === 'replay_code' || column === 'player_code') continue;
        const got = row[column] as number;
        const want = value === null ? Number.NaN : (value as number);
        if (!Object.is(got, want) && !(Number.isNaN(got) && Number.isNaN(want))) {
          mismatches.push(`${key(expected)} ${column}: ${got} != ${want}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('summary가 결과 행에서 같은 값으로 재구성된다', () => {
    const actual = new Map(buildSummaries(results).map((row) => [row.player_code, row as Json]));
    expect(actual.size).toBe(fixture.expected_summary.length);
    const mismatches: string[] = [];
    for (const expected of fixture.expected_summary) {
      const row = actual.get(expected.player_code as string) as Json;
      for (const [column, value] of Object.entries(expected)) {
        if (column === 'guild_id' || column === 'player_code') continue;
        const got = row[column.toLowerCase()];
        if (got !== value)
          mismatches.push(
            `${String(expected.player_code)} ${column}: ${String(got)} != ${String(value)}`,
          );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('직전 상태를 저장된 결과 행에서 다시 만들어 이어서 계산해도 값이 같다', () => {
    // 배치는 앞 구간의 결과 행(선수·포지션별 마지막 MMR, 판수, 승수)으로 상태를 만든다
    const valid = orderedMatches.filter((rows) => !invalidMatchReason(rows));
    const split = Math.floor(valid.length / 2);
    const stored = results.filter((row) =>
      valid.slice(0, split).some((rows) => rows[0].replay_code === row.replay_code),
    );
    const resumed = new MmrState();
    for (const row of [...stored].sort(compareByPlayedAt)) {
      const prev = resumed.ensure(row.player_code, row.position);
      resumed.set(row.player_code, row.position, {
        mmr: row.pos_cumulative_mmr,
        games: prev.games + 1,
        wins: prev.wins + row.game_result,
      });
    }

    const continued = valid
      .slice(split)
      .flatMap((rows) => applyMatch(buildMatchFeatures(rows, baseline), resumed, baseline));
    const expected = new Map(results.map((row) => [key(row), row]));
    for (const row of continued) {
      const want = expected.get(key(row)) as MmrResultRow;
      expect([row.pre_game_pos_mmr, row.mmr_change, row.total_mmr]).toEqual([
        want.pre_game_pos_mmr,
        want.mmr_change,
        want.total_mmr,
      ]);
    }
    expect(continued.length).toBeGreaterThan(0);
  });

  test('position_report가 같다', () => {
    const actual = buildPositionReports(results);
    expect(Object.fromEntries(actual)).toEqual(fixture.expected_reports);
  });
});
