/**
 * 데이터팀 전체 계산 결과(DB에 저장된 값)와 백엔드 계산을 읽기 전용으로 대조한다. DB에 쓰지 않는다.
 *
 *   npx tsx scripts/mmr/verify-against-full-calc.ts <ecosystem.config.*.cjs> <출력 JSON 경로>
 *
 * ① 경기 단위 전수: 모든 경기를 저장된 직전 상태에서 한 경기씩 계산해 결과 행을 비교한다.
 *    직전 상태를 매 경기 저장값으로 되돌려 한 경기의 차이가 뒤로 번지지 않게 한다.
 * ② 배치 경로: 마지막 7일을 배치 구간으로 놓고 실제 배치의 읽기·계산 함수(loadWindowMatches,
 *    computeGuildSeason, computeSummaries, computePositionReports)를 그대로 돌려 비교한다.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [ecosystemPath, outPath] = process.argv.slice(2);
if (!ecosystemPath || !outPath) {
  throw new Error('usage: verify-against-full-calc.ts <ecosystem.config.*.cjs> <out.json>');
}
// connectionPool이 import 시점에 env를 읽으므로 그 전에 넣는다(dotenv는 이미 있는 값을 덮지 않는다).
const appEnv = createRequire(import.meta.url)(path.resolve(ecosystemPath)).apps[0].env as Record<
  string,
  unknown
>;
for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DB_SSL']) {
  process.env[key] = String(appEnv[key]);
}
process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';

const { sql } = await import('drizzle-orm');
const { db, closeDB } = await import('../../src/database/connectionPool.js');
const batch = await import('../../src/services/mmr/mmrBatch.service.js');
const { buildMatchFeatures, invalidMatchReason } = await import(
  '../../src/services/mmr/mmrFeatures.js'
);
const { applyMatch, MmrState } = await import('../../src/services/mmr/mmrFormula.js');
const { toStoredResultRow, compareByPlayedAt } = await import(
  '../../src/services/mmr/mmrAggregate.js'
);

type Row = Record<string, unknown>;
const FACTOR_COLUMNS = new Set([
  'expected_score',
  'actual_score',
  'relative_factor',
  'personal_factor',
  'final_factor',
]);

const tally = new Map<string, number>();
const examples: Row[] = [];
const note = (category: string, detail: Row) => {
  tally.set(category, (tally.get(category) ?? 0) + 1);
  if (!category.startsWith('expected') && examples.length < 40)
    examples.push({ category, ...detail });
};

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

/** 결과 행 한 줄 비교. 저장값은 pg 문자열이라 숫자로 바꿔 비교한다. */
const compareResultRow = (scope: string, computed: Row, stored: Row) => {
  for (const [column, mine] of Object.entries(computed)) {
    if (column === 'played_at') {
      // backfill로 만든 옛 경기는 마이크로초까지 있고 JS Date는 ms까지라 ms 단위로 비교한다
      const storedMs = Math.floor(Number(stored.played_at_ms));
      if ((mine as Date).getTime() !== storedMs) note(`${scope}:played_at`, { key: stored.key });
      continue;
    }
    if (!(column in stored)) continue;
    const theirs = stored[column];
    const a = typeof mine === 'number' ? mine : mine === null ? null : String(mine);
    const b = typeof mine === 'number' || mine === null ? num(theirs) : String(theirs);
    if (a === b) continue;
    const diff = typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) : null;
    const expected =
      FACTOR_COLUMNS.has(column) && diff !== null && Math.abs(diff - 0.01) < 1e-9
        ? 'expected(factor 이중 반올림, 구버전 결과)'
        : null;
    note(expected ?? `${scope}:${column}`, { key: stored.key, column, mine: a, theirs: b });
  }
};

const report: Row = {};

await db.transaction(async (tx) => {
  await tx.execute(sql`SET TRANSACTION READ ONLY`);

  const { rows: storedRows } = await tx.execute(sql`
    SELECT r.*, extract(epoch from r.played_at AT TIME ZONE 'UTC') * 1000 AS played_at_ms
    FROM mmr_match_results r
  `);
  const stored = new Map<string, Row>();
  for (const row of storedRows as Row[]) {
    const key = `${String(row.guild_id)}/${String(row.replay_code)}/${String(row.player_code)}`;
    stored.set(key, { ...row, key });
  }
  const storedMatches = new Set(
    (storedRows as Row[]).map((r) => `${String(r.guild_id)}/${String(r.replay_code)}`),
  );
  const maxPlayed = new Date(
    (storedRows as Row[]).reduce((max, r) => Math.max(max, Number(r.played_at_ms)), 0),
  );

  // ── ① 경기 단위 전수 ──
  const all = await batch.loadWindowMatches(tx, new Date(0), maxPlayed);
  const baselines = new batch.BaselineCache();
  const scopes = new Map<string, typeof all>();
  for (const rows of all) {
    const k = `${rows[0].guild_id}\u0000${rows[0].season}`;
    scopes.set(k, [...(scopes.get(k) ?? []), rows]);
  }
  let compared = 0;
  let sequentialDiverged = 0;
  for (const matches of scopes.values()) {
    const baseline = await baselines.forSeason(matches[0][0].season);
    const pinned = new MmrState();
    const sequential = new MmrState();
    for (const rows of matches) {
      const matchKey = `${rows[0].guild_id}/${rows[0].replay_code}`;
      const has = storedMatches.has(matchKey);
      const invalid = invalidMatchReason(rows);
      if (invalid && has)
        note('①:구조 판정 불일치(백엔드 제외·저장 있음)', { match: matchKey, invalid });
      if (!invalid && !has)
        note('①:저장 결과 없음(계산 이후 업로드 또는 데이터팀 제외)', { match: matchKey });
      if (invalid || !has) continue;

      const features = buildMatchFeatures(rows, baseline);
      const mine = applyMatch(features, pinned, baseline);
      const seq = applyMatch(features, sequential, baseline);
      for (const result of mine) {
        const key = `${result.guild_id}/${result.replay_code}/${result.player_code}`;
        const theirs = stored.get(key);
        if (!theirs) {
          note('①:저장 행 없음', { key });
          continue;
        }
        compareResultRow('①', toStoredResultRow(result, baseline) as Row, theirs);
        compared += 1;
        // 다음 경기가 저장값 기준으로 시작하도록 되돌린다
        pinned.ensure(result.player_code, result.position).mmr = Number(theirs.pos_cumulative_mmr);
      }
      for (const result of seq) {
        const theirs = stored.get(`${result.guild_id}/${result.replay_code}/${result.player_code}`);
        if (theirs && result.pos_cumulative_mmr !== Number(theirs.pos_cumulative_mmr)) {
          sequentialDiverged += 1;
        }
      }
    }
  }
  report.full = { comparedRows: compared, sequentialMmrDivergedRows: sequentialDiverged };

  // ── ② 배치 경로 (마지막 7일) ──
  const from = new Date(maxPlayed.getTime() - 7 * 24 * 60 * 60 * 1000);
  const windowMatches = await batch.loadWindowMatches(tx, from, maxPlayed);
  const windowScopes = new Map<string, typeof windowMatches>();
  for (const rows of windowMatches) {
    if (!storedMatches.has(`${rows[0].guild_id}/${rows[0].replay_code}`)) continue;
    const k = `${rows[0].guild_id}\u0000${rows[0].season}`;
    windowScopes.set(k, [...(windowScopes.get(k) ?? []), rows]);
  }
  let windowRows = 0;
  let summaryRows = 0;
  let reportUsers = 0;
  for (const matches of windowScopes.values()) {
    const { guild_id: guildId, season } = matches[0][0];
    const computed = await batch.computeGuildSeason(tx, guildId, season, matches, baselines);
    for (const result of computed.results) {
      const theirs = stored.get(`${result.guild_id}/${result.replay_code}/${result.player_code}`);
      if (!theirs) continue;
      compareResultRow('②', toStoredResultRow(result, computed.baseline) as Row, theirs);
      windowRows += 1;
    }

    const summaries = await batch.computeSummaries(
      tx,
      guildId,
      season,
      computed.windowCodes,
      computed.results,
    );
    const { rows: storedSummary } = await tx.execute(sql`
      SELECT * FROM mmr_user_summary WHERE guild_id = ${guildId} AND season = ${season}
    `);
    const summaryByPlayer = new Map(
      (storedSummary as Row[]).map((r) => [String(r.player_code), r]),
    );
    for (const summary of summaries) {
      const theirs = summaryByPlayer.get(summary.player_code);
      if (!theirs) {
        note('②summary:저장 행 없음', { player: summary.player_code });
        continue;
      }
      summaryRows += 1;
      for (const [column, mine] of Object.entries(summary)) {
        if (column === 'player_code') continue;
        const value = num(theirs[column]);
        if (mine === value) continue;
        const expected =
          column.endsWith('_games') && value === null && mine === 0
            ? 'expected(판수 NULL→0, 구버전 결과)'
            : null;
        note(expected ?? `②summary:${column}`, {
          player: summary.player_code,
          column,
          mine,
          theirs: value,
        });
      }
    }

    const reports = await batch.computePositionReports(tx, guildId, season, baselines);
    for (const [player, mine] of reports) {
      const theirs = (summaryByPlayer.get(player)?.position_report ?? {}) as Record<string, Row>;
      reportUsers += 1;
      for (const [position, entry] of Object.entries(mine)) {
        for (const [field, value] of Object.entries(entry)) {
          const other = theirs[position]?.[field];
          if (value === other) continue;
          const diff =
            typeof value === 'number' && typeof other === 'number' ? Math.abs(value - other) : null;
          const expected =
            diff !== null && Math.abs(diff - 0.01) < 1e-9
              ? 'expected(JSON 반올림 동률, 구버전 결과)'
              : null;
          note(expected ?? `②report:${field}`, {
            player,
            position,
            field,
            mine: value,
            theirs: other,
          });
        }
      }
    }
  }
  report.batchPath = {
    window: `${from.toISOString()} ~ ${maxPlayed.toISOString()}`,
    comparedRows: windowRows,
    comparedSummaries: summaryRows,
    comparedReportUsers: reportUsers,
  };
});

report.tally = Object.fromEntries([...tally].sort());
report.examples = examples;
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({ full: report.full, batchPath: report.batchPath, tally: report.tally }, null, 2),
);
await closeDB();
process.exit(0);
