export const MMR_POSITIONS = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;
export type MmrPosition = (typeof MMR_POSITIONS)[number];

export const BASELINE_SCOPE_ALL_GUILDS = 'all_guilds';

/** baseline이 없거나 쓸 수 없는 상태. 경기 문제가 아니라 배치 전제 문제라 배치를 멈춘다. */
export class MmrPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MmrPreconditionError';
  }
}

export interface OutcomeStats {
  lower: number;
  upper: number;
}

export interface MmrBaseline {
  id: number;
  season: string;
  baselineVersion: string;
  f1Mean: number;
  f2Mean: number;
  f1PositionMean: Record<string, number>;
  f2PositionMean: Record<string, number>;
  /** 포지션별 [지표, 가중치]. 합산 순서가 결과의 마지막 비트를 바꾸므로 Python과 같은 순서를 지킨다. */
  positionWeights: Map<string, Array<[string, number]>>;
  outcomeStats: Map<string, OutcomeStats>;
  impactRange: { lower: number; upper: number };
}

export interface MmrBaselineRow {
  id: number;
  season: string;
  baselineVersion: string;
  mmrBaseline: unknown;
  gameImpactBaseline: unknown;
  metadata: unknown;
}

export const outcomeKey = (position: string, gameResult: number): string =>
  `${position}:${gameResult}`;

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MmrPreconditionError(`baseline ${label} is not an object`);
  }
  return value as Record<string, unknown>;
};

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

const toNumberRecord = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toNumber(item);
  }
  return out;
};

/**
 * pandas DataFrame(position_weights).to_dict()와 같은 모양으로 만든다 — 지표 순서는 포지션들을
 * 차례로 훑으며 처음 나온 순서이고, 그 포지션에 없는 지표는 NaN(그러면 raw_game_impact도 NaN).
 * JSONB가 키를 자체 순서로 저장하므로 이 순서는 DB에서 읽은 그대로여야 한다.
 */
const parsePositionWeights = (value: unknown): Map<string, Array<[string, number]>> => {
  const byPosition = asRecord(value, 'position_weights');
  const featureOrder: string[] = [];
  const seen = new Set<string>();
  for (const weights of Object.values(byPosition)) {
    for (const feature of Object.keys(asRecord(weights, 'position_weights'))) {
      if (!seen.has(feature)) {
        seen.add(feature);
        featureOrder.push(feature);
      }
    }
  }
  const out = new Map<string, Array<[string, number]>>();
  for (const [position, weights] of Object.entries(byPosition)) {
    const record = weights as Record<string, unknown>;
    out.set(
      position,
      featureOrder.map((feature) => [
        feature,
        feature in record ? toNumber(record[feature]) : Number.NaN,
      ]),
    );
  }
  return out;
};

const MIN_BASELINE_MATCHES = 200;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * gmok_mmr validate_baseline_payload와 같은 조건. 퇴화한 baseline으로 계산하면 지표가 비어
 * MMR이 고정폭으로 조용히 쌓이므로, 경기를 건너뛰지 않고 배치를 멈춘다.
 */
const baselineProblems = (row: MmrBaselineRow): string[] => {
  const problems: string[] = [];
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const matchCount = metadata.match_count;
  if (!Number.isInteger(matchCount)) problems.push(`match_count=${String(matchCount)}`);
  else if ((matchCount as number) < MIN_BASELINE_MATCHES) {
    problems.push(`match_count=${String(matchCount)} < ${MIN_BASELINE_MATCHES}`);
  }

  const gameImpact = (row.gameImpactBaseline ?? {}) as Record<string, unknown>;
  const weights = (gameImpact.position_weights ?? {}) as Record<string, Record<string, unknown>>;
  for (const position of MMR_POSITIONS) {
    const values = Object.values(weights[position] ?? {});
    if (values.length === 0) problems.push(`no Game Impact weights for ${position}`);
    else if (
      !values.every(isFiniteNumber) ||
      (values as number[]).reduce((sum, value) => sum + value, 0) <= 0
    ) {
      problems.push(`invalid Game Impact weights for ${position}`);
    }
  }

  const covered = new Set(
    ((gameImpact.outcome_stats as Array<Record<string, unknown>>) ?? [])
      .filter(
        (stat) =>
          isFiniteNumber(stat.lower) && isFiniteNumber(stat.upper) && stat.upper > stat.lower,
      )
      .map((stat) => outcomeKey(String(stat.position), Number(stat.game_result))),
  );
  const missing = MMR_POSITIONS.flatMap((position) =>
    [0, 1].map((result) => outcomeKey(position, result)),
  ).filter((key) => !covered.has(key));
  if (missing.length > 0) problems.push(`no outcome_stats for ${missing.join(',')}`);

  const range = (gameImpact.impact_range ?? {}) as Record<string, unknown>;
  if (!(isFiniteNumber(range.lower) && isFiniteNumber(range.upper) && range.upper > range.lower)) {
    problems.push('invalid game_impact impact_range');
  }

  const mmr = (row.mmrBaseline ?? {}) as Record<string, unknown>;
  for (const key of ['f1_mean', 'f2_mean']) {
    if (!isFiniteNumber(mmr[key]) || mmr[key] === 0) problems.push(`${key}=${String(mmr[key])}`);
  }
  for (const key of ['f1_position_mean', 'f2_position_mean']) {
    const means = (mmr[key] ?? {}) as Record<string, unknown>;
    const bad = MMR_POSITIONS.filter((position) => !isFiniteNumber(means[position]));
    if (bad.length > 0) problems.push(`${key} missing for ${bad.join(',')}`);
  }
  return problems;
};

export const parseBaselineRow = (row: MmrBaselineRow): MmrBaseline => {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (metadata.scope !== BASELINE_SCOPE_ALL_GUILDS) {
    throw new MmrPreconditionError(
      `baseline ${row.season}/${row.baselineVersion} scope=${String(metadata.scope)} is not ${BASELINE_SCOPE_ALL_GUILDS}`,
    );
  }
  const problems = baselineProblems(row);
  if (problems.length > 0) {
    throw new MmrPreconditionError(
      `baseline ${row.season}/${row.baselineVersion} is unusable: ${problems.join('; ')}`,
    );
  }
  const mmr = asRecord(row.mmrBaseline, 'mmr_baseline');
  const gameImpact = asRecord(row.gameImpactBaseline, 'game_impact_baseline');

  const impactRange = gameImpact.impact_range as { lower?: unknown; upper?: unknown } | undefined;
  const lower = toNumber(impactRange?.lower);
  const upper = toNumber(impactRange?.upper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower) {
    throw new MmrPreconditionError(
      `baseline ${row.season}/${row.baselineVersion} has no usable impact_range`,
    );
  }

  const outcomeStats = new Map<string, OutcomeStats>();
  for (const stat of (gameImpact.outcome_stats as Array<Record<string, unknown>>) ?? []) {
    outcomeStats.set(outcomeKey(String(stat.position), Number(stat.game_result)), {
      lower: toNumber(stat.lower),
      upper: toNumber(stat.upper),
    });
  }

  return {
    id: row.id,
    season: row.season,
    baselineVersion: row.baselineVersion,
    f1Mean: toNumber(mmr.f1_mean),
    f2Mean: toNumber(mmr.f2_mean),
    f1PositionMean: toNumberRecord(mmr.f1_position_mean),
    f2PositionMean: toNumberRecord(mmr.f2_position_mean),
    positionWeights: parsePositionWeights(gameImpact.position_weights),
    outcomeStats,
    impactRange: { lower, upper },
  };
};
