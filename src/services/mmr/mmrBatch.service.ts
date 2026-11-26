import { and, Column, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { db, DbOrTx, getClient, TransactionType } from '../../database/connectionPool.js';
import {
  mmrBaselines,
  mmrBatchRun,
  mmrMatchResult,
  mmrUserSummary,
} from '../../database/schema.js';
import { MmrBaseline, MmrPreconditionError, parseBaselineRow } from './mmrBaseline.js';
import {
  buildMatchFeatures,
  invalidMatchReason,
  MmrFeatureRow,
  MmrSourceRow,
} from './mmrFeatures.js';
import { applyMatch, MmrMatchError, MmrResultRow, MmrState } from './mmrFormula.js';
import {
  buildPositionReports,
  buildSummaries,
  compareByPlayedAt,
  StoredResultRow,
  SummaryRow,
  toStoredResultRow,
} from './mmrAggregate.js';
import { calculableCutoff, cutoffAtOrBefore } from './mmrSchedule.js';

// 배치 동시 실행 방지용(세션 advisory lock). 다른 기능의 키와 겹치지 않는 값이어야 한다.
const BATCH_LOCK_KEY = 349_000_001;
const WINDOW_WARN_HOURS = 48;

export interface SkippedMatch {
  guildId: string;
  replayCode: string;
  reason: string;
}

export interface MmrBatchReport {
  status: 'done' | 'noop';
  cutoffFrom: Date;
  cutoffTo: Date;
  guildSeasons: number;
  processedMatches: number;
  skippedMatches: SkippedMatch[];
}

const SOURCE_COLUMNS = sql.raw(`
  m.guild_id, m.custom_match_id AS replay_code,
  COALESCE(m.player_code, ra.player_code) AS player_code,
  m.champion_id, m.game_team AS team, m.position, m.game_result,
  extract(epoch from m.played_date) * 1000 AS played_at_ms,
  m.kills, m.deaths, m.assists, m.penta_kills, m.gold_earned AS gold, m.cc_time, m.game_duration,
  m.damage_to_champions, m.damage_taken, m.vision_score, m.control_wards_bought AS vision_bought,
  m.exp, m.damage_to_turrets, m.minions_killed, m.neutral_minions_killed, m.wards_placed,
  m.wards_killed, m.heal_on_teammates, m.shield_on_teammates`);

const toNumberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

// 한 문장의 바인드 파라미터는 65535개가 상한이다. 결과 행은 43개, summary 행은 21개를 쓴다.
const RESULT_CHUNK = 500;
const SUMMARY_CHUNK = 1000;

export const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** node-pg가 돌려준 행(bigint·numeric은 문자열)을 계산 입력으로. 계정이 없으면 빈 문자열 → 5v5 검증에서 걸린다. */
export const toSourceRow = (row: Record<string, unknown>, season: string): MmrSourceRow => ({
  replay_code: String(row.replay_code),
  guild_id: String(row.guild_id),
  season,
  player_code:
    row.player_code === null || row.player_code === undefined ? '' : String(row.player_code),
  champion_id: (row.champion_id as string | null) ?? null,
  team: String(row.team),
  position: String(row.position),
  game_result: Number(row.game_result),
  played_at: new Date(Number(row.played_at_ms)),
  kills: toNumberOrNull(row.kills),
  deaths: toNumberOrNull(row.deaths),
  assists: toNumberOrNull(row.assists),
  penta_kills: toNumberOrNull(row.penta_kills),
  gold: toNumberOrNull(row.gold),
  cc_time: toNumberOrNull(row.cc_time),
  game_duration: toNumberOrNull(row.game_duration),
  damage_to_champions: toNumberOrNull(row.damage_to_champions),
  damage_taken: toNumberOrNull(row.damage_taken),
  vision_score: toNumberOrNull(row.vision_score),
  vision_bought: toNumberOrNull(row.vision_bought),
  exp: toNumberOrNull(row.exp),
  damage_to_turrets: toNumberOrNull(row.damage_to_turrets),
  minions_killed: toNumberOrNull(row.minions_killed),
  neutral_minions_killed: toNumberOrNull(row.neutral_minions_killed),
  wards_placed: toNumberOrNull(row.wards_placed),
  wards_killed: toNumberOrNull(row.wards_killed),
  heal_on_teammates: toNumberOrNull(row.heal_on_teammates),
  shield_on_teammates: toNumberOrNull(row.shield_on_teammates),
});

const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
};

export class BaselineCache {
  private readonly bySeason = new Map<string, MmrBaseline>();

  private readonly byVersion = new Map<string, MmrBaseline>();

  /** 경기 시즌의 활성 baseline, 없으면 가장 최근에 저장된 활성 baseline. */
  public async forSeason(season: string): Promise<MmrBaseline> {
    const cached = this.bySeason.get(season);
    if (cached) return cached;
    const [row] = await db
      .select()
      .from(mmrBaselines)
      .where(eq(mmrBaselines.isActive, true))
      .orderBy(
        sql`(${mmrBaselines.season} = ${season}) DESC`,
        desc(mmrBaselines.savedAt),
        desc(mmrBaselines.id),
      )
      .limit(1);
    if (!row) throw new MmrPreconditionError('no active mmr baseline');
    const baseline = parseBaselineRow(row);
    this.bySeason.set(season, baseline);
    return baseline;
  }

  /** 결과 행에 기록된 baseline. 리포트를 다시 계산할 때 그 경기를 계산한 baseline으로 지표를 만든다. */
  public async byRecord(season: string, version: string): Promise<MmrBaseline> {
    const key = `${season}\u0000${version}`;
    const cached = this.byVersion.get(key);
    if (cached) return cached;
    const [row] = await db
      .select()
      .from(mmrBaselines)
      .where(and(eq(mmrBaselines.season, season), eq(mmrBaselines.baselineVersion, version)))
      .limit(1);
    if (!row) throw new MmrPreconditionError(`mmr baseline ${season}/${version} not found`);
    const baseline = parseBaselineRow(row);
    this.byVersion.set(key, baseline);
    return baseline;
  }
}

const excludedSet = (columns: Record<string, Column>, skip: string[]) =>
  Object.fromEntries(
    Object.entries(columns)
      .filter(([key]) => !skip.includes(key))
      .map(([key, column]) => [key, sql.raw(`excluded."${column.name}"`)]),
  );

const RESULT_UPDATE_SET = excludedSet(getTableColumns(mmrMatchResult), [
  'id',
  'guildId',
  'replayCode',
  'playerCode',
  'calculatedAt',
]);

const toResultInsert = (row: StoredResultRow) => ({
  guildId: row.guild_id,
  season: row.season,
  replayCode: row.replay_code,
  playerCode: row.player_code,
  championId: row.champion_id,
  team: row.team,
  position: row.position,
  playedAt: row.played_at,
  gameResult: row.game_result,
  kills: row.kills as number | null,
  deaths: row.deaths as number | null,
  assists: row.assists as number | null,
  gold: row.gold as number | null,
  ccTime: row.cc_time as number | null,
  gameDuration: row.game_duration as number | null,
  damageToChampions: row.damage_to_champions as number | null,
  damageTaken: row.damage_taken as number | null,
  visionScore: row.vision_score as number | null,
  visionBought: row.vision_bought as number | null,
  pentaKills: row.penta_kills as number | null,
  goldPerMin: row.gold_per_min as number | null,
  dpm: row.dpm as number | null,
  damageTakenPerMin: row.damage_taken_per_min as number | null,
  ccTimePerMin: row.cc_time_per_min as number | null,
  kda: row.kda as number | null,
  damageTakenPerDeath: row.damage_taken_per_death as number | null,
  damageDealtPerDeath: row.damage_dealt_per_death as number | null,
  rawGameImpact: row.raw_game_impact as number | null,
  gameImpact: row.game_impact as number | null,
  gameImpactWinlossNorm: row.game_impact_winloss_norm as number | null,
  gameNPersonContribution: row.game_n_person_contribution as number | null,
  gameImpactVsOpponent: row.game_impact_vs_opponent as number | null,
  preGamePosMmr: row.pre_game_pos_mmr as number | null,
  expectedScore: row.expected_score as number | null,
  actualScore: row.actual_score as number | null,
  relativeFactor: row.relative_factor as number | null,
  personalFactor: row.personal_factor as number | null,
  finalFactor: row.final_factor as number | null,
  mmrChange: row.mmr_change as number | null,
  posCumulativeMmr: row.pos_cumulative_mmr as number | null,
  totalMmr: row.total_mmr as number | null,
  baselineSeason: row.baseline_season,
  baselineVersion: row.baseline_version,
});

// position_report는 빼야 한다 — 덮어쓰면 '{}'가 되므로 리포트 단계가 따로 채운다.
const SUMMARY_UPDATE_SET = excludedSet(getTableColumns(mmrUserSummary), [
  'id',
  'guildId',
  'season',
  'playerCode',
  'positionReport',
  'calculatedAt',
]);

/** 길드·시즌의 직전 상태: 구간 밖(이미 확정된) 결과 행에서 선수별·포지션별 마지막 MMR과 판수. */
export const loadState = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  players: string[],
  windowCodes: string[],
): Promise<MmrState> => {
  const state = new MmrState();
  if (players.length === 0) return state;
  // 다시 돌리는 구간의 결과(앞선 실행이 일부 길드만 커밋한 경우)는 상태에서 빼야 두 번 쌓이지 않는다.
  const { rows } = await tx.execute(sql`
    SELECT DISTINCT ON (player_code, position)
      player_code, position, pos_cumulative_mmr,
      count(*) OVER (PARTITION BY player_code, position) AS games,
      sum(game_result) OVER (PARTITION BY player_code, position) AS wins
    FROM mmr_match_results
    WHERE guild_id = ${guildId} AND season = ${season}
      AND player_code IN ${players}
      AND replay_code NOT IN ${windowCodes}
    ORDER BY player_code, position, played_at DESC, replay_code COLLATE "C" DESC
  `);
  for (const row of rows as Array<Record<string, unknown>>) {
    state.set(String(row.player_code), String(row.position), {
      mmr: Number(row.pos_cumulative_mmr),
      games: Number(row.games),
      wins: Number(row.wins),
    });
  }
  return state;
};

/**
 * 이번 구간에서 계산한 선수의 summary: 구간 밖 저장 결과 + 이번 계산 결과로 다시 만든다.
 * 구간 경기를 저장 여부와 상관없이 빼고 더하므로, 쓰기 전이든 후든 같은 값이 나온다.
 */
export const computeSummaries = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  windowCodes: string[],
  computed: readonly MmrResultRow[],
): Promise<SummaryRow[]> => {
  const players = [...new Set(computed.map((row) => row.player_code))];
  if (players.length === 0) return [];
  const { rows } = await tx.execute(sql`
    SELECT player_code, position, game_result, replay_code, pos_cumulative_mmr, total_mmr,
      extract(epoch from played_at AT TIME ZONE 'UTC') * 1000 AS played_at_ms
    FROM mmr_match_results
    WHERE guild_id = ${guildId} AND season = ${season} AND player_code IN ${players}
      AND replay_code NOT IN ${windowCodes}
  `);
  const stored = (rows as Array<Record<string, unknown>>).map((row) => ({
    player_code: String(row.player_code),
    position: String(row.position),
    game_result: Number(row.game_result),
    replay_code: String(row.replay_code),
    pos_cumulative_mmr: Number(row.pos_cumulative_mmr),
    total_mmr: Number(row.total_mmr),
    played_at: new Date(Number(row.played_at_ms)),
  }));
  return buildSummaries([...stored, ...computed]);
};

const writeSummaries = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  summaries: SummaryRow[],
): Promise<void> => {
  for (const part of chunk(summaries, SUMMARY_CHUNK)) {
    await upsertSummaries(tx, guildId, season, part);
  }
};

const upsertSummaries = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  summaries: SummaryRow[],
): Promise<void> => {
  await tx
    .insert(mmrUserSummary)
    .values(
      summaries.map((summary) => ({
        guildId,
        season,
        playerCode: summary.player_code,
        totalMmr: summary.total_mmr,
        totalGames: summary.total_games,
        overallWinrate: summary.overall_winrate,
        topMmr: summary.top_mmr as number | null,
        topWinrate: summary.top_winrate as number | null,
        topGames: summary.top_games as number,
        jugMmr: summary.jug_mmr as number | null,
        jugWinrate: summary.jug_winrate as number | null,
        jugGames: summary.jug_games as number,
        midMmr: summary.mid_mmr as number | null,
        midWinrate: summary.mid_winrate as number | null,
        midGames: summary.mid_games as number,
        adcMmr: summary.adc_mmr as number | null,
        adcWinrate: summary.adc_winrate as number | null,
        adcGames: summary.adc_games as number,
        supMmr: summary.sup_mmr as number | null,
        supWinrate: summary.sup_winrate as number | null,
        supGames: summary.sup_games as number,
      })),
    )
    .onConflictDoUpdate({
      target: [mmrUserSummary.guildId, mmrUserSummary.playerCode, mmrUserSummary.season],
      set: { ...SUMMARY_UPDATE_SET, calculatedAt: sql`now()` },
    });
};

/**
 * 길드·시즌 전체의 포지션 리포트를 다시 만든다. 백분위가 비교군 전체에 걸려 있어 일부만 바꿀 수 없다.
 * 지표는 저장된(반올림된) 결과가 아니라 원천 metric과 그 경기에 기록된 baseline으로 다시 계산한다 —
 * gmok_mmr 전체 계산의 리포트도 반올림 전 값으로 만들어졌다.
 */
export const computePositionReports = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  baselines: BaselineCache,
): Promise<Map<string, Record<string, Record<string, unknown>>>> => {
  const { rows } = await tx.execute(sql`
    SELECT ${SOURCE_COLUMNS}, r.baseline_season, r.baseline_version
    FROM mmr_match_results r
    JOIN mmr_participant_metric m
      ON m.custom_match_id = r.replay_code AND m.guild_id = r.guild_id
    LEFT JOIN riot_account ra ON ra.puuid = m.puuid
    WHERE r.guild_id = ${guildId} AND r.season = ${season}
      AND COALESCE(m.player_code, ra.player_code) = r.player_code
    ORDER BY m.played_date, m.custom_match_id COLLATE "C", m.id
  `);
  const records = rows as Array<Record<string, unknown>>;
  const features: MmrFeatureRow[] = [];
  for (const matchRows of groupBy(records, (row) => String(row.replay_code)).values()) {
    const baseline = await baselines.byRecord(
      String(matchRows[0].baseline_season),
      String(matchRows[0].baseline_version),
    );
    const source = matchRows.map((row) => toSourceRow(row, season));
    // 결과가 있는 경기는 계산 당시 5v5를 통과했다. 원천이 그 뒤 달라졌다면 리포트에서 뺀다.
    if (invalidMatchReason(source)) continue;
    features.push(...buildMatchFeatures(source, baseline));
  }
  features.sort(
    (a, b) =>
      compareByPlayedAt(a, b) ||
      (a.player_code < b.player_code ? -1 : a.player_code > b.player_code ? 1 : 0),
  );

  return buildPositionReports(features);
};

const writePositionReports = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  reports: Map<string, Record<string, Record<string, unknown>>>,
): Promise<void> => {
  if (reports.size === 0) return;
  const payload = JSON.stringify(
    [...reports].map(([playerCode, report]) => ({ player_code: playerCode, report })),
  );
  await tx.execute(sql`
    UPDATE mmr_user_summary s
    SET position_report = v.report, calculated_at = now()
    FROM jsonb_to_recordset(${payload}::jsonb) AS v(player_code varchar, report jsonb)
    WHERE s.guild_id = ${guildId} AND s.season = ${season} AND s.player_code = v.player_code
  `);
};

export interface GuildSeasonComputation {
  baseline: MmrBaseline;
  windowCodes: string[];
  results: MmrResultRow[];
  skipped: SkippedMatch[];
}

/** 한 길드·시즌의 구간 경기를 계산한다. 읽기만 한다 — 배치와 운영 대조 스크립트가 같은 경로를 쓴다. */
export const computeGuildSeason = async (
  tx: TransactionType,
  guildId: string,
  season: string,
  matches: MmrSourceRow[][],
  baselines: BaselineCache,
): Promise<GuildSeasonComputation> => {
  const baseline = await baselines.forSeason(season);
  const windowCodes = matches.map((rows) => rows[0].replay_code);
  const players = [...new Set(matches.flat().map((row) => row.player_code))];
  const state = await loadState(tx, guildId, season, players, windowCodes);
  const results: MmrResultRow[] = [];
  const skipped: SkippedMatch[] = [];
  for (const rows of matches) {
    const invalid = invalidMatchReason(rows);
    if (invalid) {
      skipped.push({ guildId, replayCode: rows[0].replay_code, reason: invalid });
      continue;
    }
    try {
      results.push(...applyMatch(buildMatchFeatures(rows, baseline), state, baseline));
    } catch (error) {
      if (!(error instanceof MmrMatchError)) throw error;
      skipped.push({ guildId, replayCode: rows[0].replay_code, reason: error.message });
    }
  }
  return { baseline, windowCodes, results, skipped };
};

const processGuildSeason = async (
  guildId: string,
  season: string,
  matches: MmrSourceRow[][],
  baselines: BaselineCache,
  skipped: SkippedMatch[],
): Promise<number> =>
  db.transaction(async (tx) => {
    const computed = await computeGuildSeason(tx, guildId, season, matches, baselines);
    skipped.push(...computed.skipped);
    const { baseline, windowCodes, results } = computed;
    if (results.length === 0) return 0;

    for (const part of chunk(results, RESULT_CHUNK)) {
      await tx
        .insert(mmrMatchResult)
        .values(part.map((row) => toResultInsert(toStoredResultRow(row, baseline))))
        .onConflictDoUpdate({
          target: [mmrMatchResult.guildId, mmrMatchResult.replayCode, mmrMatchResult.playerCode],
          set: { ...RESULT_UPDATE_SET, calculatedAt: sql`now()` },
        });
    }
    await writeSummaries(
      tx,
      guildId,
      season,
      await computeSummaries(tx, guildId, season, windowCodes, results),
    );
    // 리포트는 방금 쓴 결과까지 포함한 길드·시즌 전체가 입력이라 결과를 쓴 뒤에 계산한다.
    await writePositionReports(
      tx,
      guildId,
      season,
      await computePositionReports(tx, guildId, season, baselines),
    );
    return new Set(results.map((row) => row.replay_code)).size;
  });

const lastCutoff = async (): Promise<Date | null> => {
  const [row] = await db
    .select({ cutoffTo: mmrBatchRun.cutoffTo })
    .from(mmrBatchRun)
    .where(inArray(mmrBatchRun.status, ['done', 'seed']))
    .orderBy(desc(mmrBatchRun.cutoffTo))
    .limit(1);
  return row?.cutoffTo ?? null;
};

export const loadWindowMatches = async (
  executor: DbOrTx,
  from: Date,
  to: Date,
): Promise<MmrSourceRow[][]> => {
  // 길드·시즌 그룹 안에서 경기 순서는 played_at·replay_code(코드포인트) — gmok_mmr과 같다.
  const { rows } = await executor.execute(sql`
    SELECT ${SOURCE_COLUMNS}, cm.season
    FROM mmr_participant_metric m
    JOIN custom_match cm ON cm.id = m.custom_match_id
    LEFT JOIN riot_account ra ON ra.puuid = m.puuid
    WHERE m.played_date > ${from.toISOString()}::timestamptz
      AND m.played_date <= ${to.toISOString()}::timestamptz
      AND m.game_type = '1' AND m.is_deleted = false AND m.is_mmr_eligible = true
    ORDER BY m.played_date, m.custom_match_id COLLATE "C", m.id
  `);
  const records = rows as Array<Record<string, unknown>>;
  // 시즌 문자열 앞뒤 공백은 gmok_mmr normalize_season처럼 지운다 — 남기면 다른 시즌으로 1300부터 다시 시작한다.
  return [...groupBy(records, (row) => String(row.replay_code)).values()].map((matchRows) =>
    matchRows.map((row) => toSourceRow(row, String(row.season).trim())),
  );
};

const withBatchLock = async <T>(run: () => Promise<T>): Promise<T> => {
  const client = await getClient();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [BATCH_LOCK_KEY],
    );
    if (!rows[0]?.locked) throw new MmrPreconditionError('another mmr batch is running');
    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [BATCH_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
};

/**
 * 서비스 시작 때 한 번: 데이터팀 전체 계산이 자른 컷오프를 첫 구간의 시작점으로 기록한다.
 * 이 기록 없이 배치를 돌리면 과거 전체를 서버에서 계산하게 되므로 배치는 seed가 없으면 멈춘다.
 *
 * 전체 계산도 배치와 같은 규칙(삭제 마감이 지난 컷오프까지)으로 잘려 있어야 한다. 아직 지울 수 있는
 * 경기가 결과에 들어가 있으면, 지워져도 되돌릴 수 없어 MMR에 영구히 남는다. 전체 계산을 마감 전에
 * 돌렸는지는 알 수 없으므로, 결과에 든 경기가 지금도 계산 대상인지(그 사이 지워지지 않았는지)를 본다.
 */
export const seedMmrBatchWatermark = async (cutoff: Date, now: Date = new Date()): Promise<Date> =>
  withBatchLock(async () => {
    if (cutoffAtOrBefore(cutoff).getTime() !== cutoff.getTime()) {
      throw new MmrPreconditionError(`seed ${cutoff.toISOString()} is not a 06:00 KST cutoff`);
    }
    if (cutoff.getTime() > calculableCutoff(now).getTime()) {
      throw new MmrPreconditionError(
        `seed ${cutoff.toISOString()} is still within the replay delete window`,
      );
    }
    if (await lastCutoff()) throw new MmrPreconditionError('mmr batch watermark already exists');

    const { rows } = await db.execute(sql`
      SELECT
        count(DISTINCT (r.guild_id, r.replay_code)) AS results,
        count(DISTINCT (r.guild_id, r.replay_code))
          FILTER (WHERE m.played_date > ${cutoff.toISOString()}::timestamptz) AS after_cutoff,
        count(DISTINCT (r.guild_id, r.replay_code))
          FILTER (WHERE r.played_at <> (m.played_date AT TIME ZONE 'UTC')) AS shifted,
        count(DISTINCT (r.guild_id, r.replay_code))
          FILTER (WHERE m.id IS NULL OR m.is_deleted OR NOT m.is_mmr_eligible OR m.game_type <> '1')
          AS excluded
      FROM mmr_match_results r
      LEFT JOIN mmr_participant_metric m
        ON m.custom_match_id = r.replay_code AND m.guild_id = r.guild_id
    `);
    const check = (rows as Array<Record<string, unknown>>)[0];
    if (Number(check.results) === 0) {
      throw new MmrPreconditionError(
        'mmr_match_results is empty; run the one-time calculation first',
      );
    }
    if (Number(check.after_cutoff) > 0) {
      throw new MmrPreconditionError(
        `${String(check.after_cutoff)} result matches are after the seed cutoff; recalculate up to ${cutoff.toISOString()}`,
      );
    }
    if (Number(check.excluded) > 0) {
      throw new MmrPreconditionError(
        `${String(check.excluded)} result matches are deleted or no longer MMR targets; recalculate`,
      );
    }
    // 배치는 played_at을 UTC 벽시계 시각으로 쓴다. 전체 계산이 다른 세션 시간대로 썼다면 순서 비교가 어긋난다.
    if (Number(check.shifted) > 0) {
      throw new MmrPreconditionError(
        `${String(check.shifted)} result matches have played_at not equal to played_date in UTC`,
      );
    }

    await db.insert(mmrBatchRun).values({
      cutoffFrom: cutoff,
      cutoffTo: cutoff,
      status: 'seed',
      finishedAt: new Date(),
    });
    return cutoff;
  });

/**
 * MMR 배치 1회: (마지막 성공 컷오프, 삭제 마감이 지난 06:00 KST]에 올라온 일반내전을 길드·시즌별로 계산한다.
 * 실패하면 컷오프를 기록하지 않아 다음 실행이 같은 구간을 다시 처리한다(결과 upsert라 반복해도 같다).
 */
export const runMmrBatch = async (now: Date = new Date()): Promise<MmrBatchReport> =>
  withBatchLock(async () => {
    const from = await lastCutoff();
    if (!from) {
      throw new MmrPreconditionError(
        'mmr batch watermark missing; run the batch with --seed first',
      );
    }
    const to = calculableCutoff(now);
    if (to.getTime() <= from.getTime()) {
      return {
        status: 'noop',
        cutoffFrom: from,
        cutoffTo: to,
        guildSeasons: 0,
        processedMatches: 0,
        skippedMatches: [],
      };
    }
    if (to.getTime() - from.getTime() > WINDOW_WARN_HOURS * 60 * 60 * 1000) {
      console.warn(
        `[mmrBatch] window ${from.toISOString()} ~ ${to.toISOString()} is longer than ${WINDOW_WARN_HOURS}h — a daily run was missed`,
      );
    }

    const [run] = await db
      .insert(mmrBatchRun)
      .values({ cutoffFrom: from, cutoffTo: to, status: 'running' })
      .returning({ id: mmrBatchRun.id });

    const skipped: SkippedMatch[] = [];
    let processed = 0;
    let guildSeasons = 0;
    try {
      const matches = await loadWindowMatches(db, from, to);
      const baselines = new BaselineCache();
      const scopes = groupBy(matches, (rows) => `${rows[0].guild_id}\u0000${rows[0].season}`);
      for (const scopeMatches of scopes.values()) {
        const { guild_id: guildId, season } = scopeMatches[0][0];
        processed += await processGuildSeason(guildId, season, scopeMatches, baselines, skipped);
        guildSeasons += 1;
      }
    } catch (error) {
      await db
        .update(mmrBatchRun)
        .set({
          status: 'aborted',
          guildSeasons,
          processedMatches: processed,
          skippedMatches: skipped,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          finishedAt: new Date(),
        })
        .where(eq(mmrBatchRun.id, run.id));
      throw error;
    }

    await db
      .update(mmrBatchRun)
      .set({
        status: 'done',
        guildSeasons,
        processedMatches: processed,
        skippedMatches: skipped,
        finishedAt: new Date(),
      })
      .where(eq(mmrBatchRun.id, run.id));

    return {
      status: 'done',
      cutoffFrom: from,
      cutoffTo: to,
      guildSeasons,
      processedMatches: processed,
      skippedMatches: skipped,
    };
  });
