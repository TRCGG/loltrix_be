import { MMR_POSITIONS, MmrBaseline, outcomeKey } from './mmrBaseline.js';
import { kahanSum, roundNumpy } from './mmrRounding.js';

/**
 * 원천 metric 한 행. 이름은 gmok_mmr 로더가 쓰는 이름(snake_case)이다 — baseline 가중치와
 * 결과 테이블 컬럼이 이 이름으로 맞물린다.
 */
export interface MmrSourceRow {
  replay_code: string;
  guild_id: string;
  season: string;
  player_code: string;
  champion_id: string | null;
  team: string;
  position: string;
  game_result: number;
  played_at: Date;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  penta_kills: number | null;
  gold: number | null;
  cc_time: number | null;
  /** 초 단위 원천값 */
  game_duration: number | null;
  damage_to_champions: number | null;
  damage_taken: number | null;
  vision_score: number | null;
  vision_bought: number | null;
  exp: number | null;
  damage_to_turrets: number | null;
  minions_killed: number | null;
  neutral_minions_killed: number | null;
  wards_placed: number | null;
  wards_killed: number | null;
  heal_on_teammates: number | null;
  shield_on_teammates: number | null;
}

const RAW_NUMERIC_FIELDS = [
  'kills',
  'deaths',
  'assists',
  'penta_kills',
  'gold',
  'cc_time',
  'damage_to_champions',
  'damage_taken',
  'vision_score',
  'vision_bought',
  'exp',
  'damage_to_turrets',
  'minions_killed',
  'neutral_minions_killed',
  'wards_placed',
  'wards_killed',
  'heal_on_teammates',
  'shield_on_teammates',
] as const;

const DERIVED_FIELDS = [
  'game_duration',
  'gold_per_min',
  'dpm',
  'damage_taken_per_min',
  'cc_time_per_min',
  'kda',
  'damage_taken_per_death',
  'damage_dealt_per_death',
  'exp_per_min',
  'damage_to_turrets_per_min',
  'cs_per_min',
  'wards_placed_per_min',
  'wards_killed_per_min',
  'lane_gold_diff',
] as const;

type NumericField = (typeof RAW_NUMERIC_FIELDS)[number] | (typeof DERIVED_FIELDS)[number];

export type MmrFeatureRow = Omit<MmrSourceRow, NumericField> & {
  [K in NumericField]: number;
} & {
  /** 위치가 baseline에 없거나 가중치가 비면 NaN */
  raw_game_impact: number;
  game_impact: number;
  game_impact_winloss_norm: number;
  game_n_person_contribution: number;
  /** 같은 포지션 승·패 짝이 없을 때만 NaN */
  game_impact_vs_opponent: number;
};

const nan = (value: number | null): number => (value === null ? Number.NaN : value);

/** pandas 나눗셈과 같다: 0으로 나누면 ±inf, 0/0·NaN은 NaN. */
const div = (a: number, b: number): number => a / b;

/** 5v5 구조 검증(Python validate_mmr_input_matches·drop_invalid_matches). 실패 사유를 돌려준다. */
export const invalidMatchReason = (rows: readonly MmrSourceRow[]): string | null => {
  if (rows.length !== 10) return `rows=${rows.length}`;
  const players = new Set<string>();
  for (const row of rows) {
    if (!row.player_code.trim() || !row.replay_code || !row.guild_id) return 'missing identifier';
    if (row.game_result !== 0 && row.game_result !== 1) return `game_result=${row.game_result}`;
    if (players.has(row.player_code)) return `duplicated player ${row.player_code}`;
    players.add(row.player_code);
  }
  for (const position of MMR_POSITIONS) {
    const slots = rows.filter((row) => row.position === position);
    if (slots.length !== 2) return `${position} rows=${slots.length}`;
    if (slots[0].game_result + slots[1].game_result !== 1) return `${position} not 1 win 1 loss`;
  }
  return null;
};

/** clean_match_data + add_basic_features. 마지막에 inf·NaN을 0으로 채우는 것까지 Python과 같다. */
const addBasicFeatures = (rows: readonly MmrSourceRow[]): MmrFeatureRow[] => {
  const base = rows.map((row) => {
    const numbers: Record<string, number> = {};
    for (const field of RAW_NUMERIC_FIELDS) numbers[field] = nan(row[field]);
    numbers.heal_on_teammates = Number.isNaN(numbers.heal_on_teammates)
      ? 0
      : numbers.heal_on_teammates;
    numbers.shield_on_teammates = Number.isNaN(numbers.shield_on_teammates)
      ? 0
      : numbers.shield_on_teammates;
    numbers.game_duration = roundNumpy(nan(row.game_duration) / 60, 2);
    return { row, numbers };
  });

  // lane_gold_diff: 같은 경기·포지션 상대 gold와의 차. pandas transform(sum/count)처럼 NaN은 빼고 센다.
  const laneGold = new Map<string, { sum: number; count: number }>();
  for (const position of MMR_POSITIONS) {
    const golds = base.filter((b) => b.row.position === position).map((b) => b.numbers.gold);
    laneGold.set(position, kahanSum(golds));
  }

  return base.map(({ row, numbers }) => {
    const n = numbers;
    const duration = n.game_duration === 0 ? Number.NaN : n.game_duration;
    const deathsSafe = n.deaths === 0 ? 1 : n.deaths;
    const lane = laneGold.get(row.position) ?? { sum: 0, count: 0 };
    const opponentCount = lane.count - 1;
    const opponentGold = div(lane.sum - n.gold, opponentCount === 0 ? Number.NaN : opponentCount);

    const derived: Record<string, number> = {
      gold_per_min: div(n.gold, duration),
      dpm: div(n.damage_to_champions, duration),
      damage_taken_per_min: div(n.damage_taken, duration),
      cc_time_per_min: div(n.cc_time, duration),
      kda: div(n.kills + n.assists, deathsSafe),
      damage_taken_per_death: div(n.damage_taken, deathsSafe),
      damage_dealt_per_death: div(n.damage_to_champions, deathsSafe),
      exp_per_min: div(n.exp, duration),
      damage_to_turrets_per_min: div(n.damage_to_turrets, duration),
      cs_per_min: div(n.minions_killed + n.neutral_minions_killed, duration),
      wards_placed_per_min: div(n.wards_placed, duration),
      wards_killed_per_min: div(n.wards_killed, duration),
      lane_gold_diff: n.gold - opponentGold,
    };

    const filled: Record<string, number> = {};
    for (const [key, value] of Object.entries({ ...n, ...derived })) {
      filled[key] = Number.isFinite(value) ? value : 0;
    }
    return {
      ...row,
      ...filled,
      raw_game_impact: Number.NaN,
      game_impact: Number.NaN,
      game_impact_winloss_norm: Number.NaN,
      game_n_person_contribution: Number.NaN,
      game_impact_vs_opponent: Number.NaN,
    } as MmrFeatureRow;
  });
};

const clip = (value: number, lower: number, upper: number): number =>
  Number.isNaN(value) ? value : Math.min(Math.max(value, lower), upper);

/** compute_raw_game_impact: 가중치 순서대로 row[지표]·가중치를 누적한다. */
const rawGameImpact = (row: MmrFeatureRow, baseline: MmrBaseline): number => {
  const weights = baseline.positionWeights.get(row.position);
  if (!weights) return Number.NaN;
  const values = row as unknown as Record<string, unknown>;
  let impact = 0;
  for (const [feature, weight] of weights) {
    const value = values[feature];
    if (typeof value === 'number' && !Number.isNaN(value)) {
      impact += value * weight;
    }
  }
  return impact;
};

/**
 * apply_game_impact_baseline(build_incremental_feature_dataframe)를 한 경기 10행에 적용한다.
 * 입력은 invalidMatchReason을 통과한 경기여야 한다.
 */
export const buildMatchFeatures = (
  rows: readonly MmrSourceRow[],
  baseline: MmrBaseline,
): MmrFeatureRow[] => {
  const features = addBasicFeatures(rows);
  const { lower, upper } = baseline.impactRange;
  // sklearn MinMaxScaler와 같은 연산 순서(scale_, min_)
  const scale = 100 / (upper - lower);

  for (const row of features) {
    row.raw_game_impact = rawGameImpact(row, baseline);
    row.game_impact = clip(row.raw_game_impact * scale - lower * scale, 0, 100);
    const stats = baseline.outcomeStats.get(outcomeKey(row.position, row.game_result));
    row.game_impact_winloss_norm =
      stats === undefined || Number.isNaN(row.raw_game_impact)
        ? Number.NaN
        : clip(((row.raw_game_impact - stats.lower) / (stats.upper - stats.lower)) * 100, 0, 100);
  }

  // compute_n_person_contribution: 경기 전체 norm 합에서의 비중 × 10. 합이 0에 가까우면 0.
  const { sum } = kahanSum(features.map((row) => row.game_impact_winloss_norm));
  const validSum = Math.abs(sum) <= 1e-8 ? Number.NaN : sum;
  for (const row of features) {
    const share = (row.game_impact_winloss_norm / validSum) * 10;
    row.game_n_person_contribution = Number.isNaN(share) ? 0 : share;
  }

  // compute_vs_opponent: 같은 포지션 승자·패자 norm 비중(0~100). 계산 불가는 0.
  for (const position of MMR_POSITIONS) {
    const winner = features.find((row) => row.position === position && row.game_result === 1);
    const loser = features.find((row) => row.position === position && row.game_result === 0);
    if (!winner || !loser) continue;
    const total = winner.game_impact_winloss_norm + loser.game_impact_winloss_norm;
    const winnerScore = (winner.game_impact_winloss_norm / total) * 100;
    const loserScore = (loser.game_impact_winloss_norm / total) * 100;
    winner.game_impact_vs_opponent = Number.isNaN(winnerScore) ? 0 : winnerScore;
    loser.game_impact_vs_opponent = Number.isNaN(loserScore) ? 0 : loserScore;
  }

  return features;
};
