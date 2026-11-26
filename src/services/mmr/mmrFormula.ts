import { MmrBaseline } from './mmrBaseline.js';
import { MmrFeatureRow } from './mmrFeatures.js';
import { roundHalfAwayFromZero, roundRatioHalfAwayFromZero } from './mmrRounding.js';

// gmok_mmr MMRSettings 기본값. 산식을 바꿀 때는 gmok_mmr과 함께 바꾼다.
export const INITIAL_MMR = 1300;
const BASE_WIN = 20;
const BASE_LOSS = -15;
const ALPHA = 0.6;
const BETA = 0.4;
const GAMMA = 0.2;
const MIN_CHANGE = -25;
const MAX_CHANGE = 30;
const MIN_ABS_CHANGE = 12;
const K_DECAY_START = 1500;
const K_DECAY_RATE = 0.002;
const K_MIN = 0.35;

/** 산식이 값을 내지 못한 경기(NaN 등). 그 경기만 건너뛴다. */
export class MmrMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MmrMatchError';
  }
}

export interface PositionState {
  mmr: number;
  wins: number;
  games: number;
}

/** 한 길드·시즌 안의 선수별 포지션 상태. 경기를 순서대로 적용하며 갱신한다. */
export class MmrState {
  private readonly players = new Map<string, Map<string, PositionState>>();

  public set(playerCode: string, position: string, state: PositionState): void {
    this.positionsOf(playerCode).set(position, { ...state });
  }

  /** 없으면 초기값으로 만든다 — Python ensure_player_position과 같다(판수 0이라 total에 영향 없음). */
  public ensure(playerCode: string, position: string): PositionState {
    const positions = this.positionsOf(playerCode);
    let state = positions.get(position);
    if (!state) {
      state = { mmr: INITIAL_MMR, wins: 0, games: 0 };
      positions.set(position, state);
    }
    return state;
  }

  public totalMmr(playerCode: string): number {
    let weightedSum = 0;
    let totalGames = 0;
    for (const state of this.positionsOf(playerCode).values()) {
      weightedSum += state.mmr * state.games;
      totalGames += state.games;
    }
    if (totalGames === 0) return INITIAL_MMR;
    // 판수 가중 평균은 .5가 자주 나와 정수 비율로 정확히 반올림한다.
    return roundRatioHalfAwayFromZero(weightedSum, totalGames);
  }

  private positionsOf(playerCode: string): Map<string, PositionState> {
    let positions = this.players.get(playerCode);
    if (!positions) {
      positions = new Map();
      this.players.set(playerCode, positions);
    }
    return positions;
  }
}

export type MmrResultRow = MmrFeatureRow & {
  pre_game_pos_mmr: number;
  expected_score: number;
  actual_score: number;
  relative_factor: number;
  personal_factor: number;
  final_factor: number;
  mmr_change: number;
  pos_cumulative_mmr: number;
  total_mmr: number;
};

const clip = (value: number, lower: number, upper: number): number =>
  Number.isNaN(value) ? value : Math.min(Math.max(value, lower), upper);

const expectedPerformance = (mmr: number, opponentMmr: number): number =>
  1 / (1 + 10 ** ((opponentMmr - mmr) / 400));

const kFactor = (mmr: number): number => {
  let k = 1.0;
  if (mmr > K_DECAY_START) k = 1.0 - (mmr - K_DECAY_START) * K_DECAY_RATE;
  return Math.max(k, K_MIN);
};

const personalFactor = (row: MmrFeatureRow, baseline: MmrBaseline): number => {
  const f1Baseline =
    row.position in baseline.f1PositionMean
      ? baseline.f1PositionMean[row.position]
      : baseline.f1Mean;
  const f2Baseline =
    row.position in baseline.f2PositionMean
      ? baseline.f2PositionMean[row.position]
      : baseline.f2Mean;
  const f1 = f1Baseline !== 0 ? row.game_n_person_contribution / f1Baseline : 1;
  const f2 =
    Number.isNaN(row.game_impact_vs_opponent) || f2Baseline === 0
      ? 1
      : row.game_impact_vs_opponent / f2Baseline;
  return clip(f1, 0.5, 2) ** ALPHA * clip(f2, 0.5, 2) ** BETA;
};

const byPlayerCode = (a: MmrFeatureRow, b: MmrFeatureRow): number =>
  a.player_code < b.player_code ? -1 : a.player_code > b.player_code ? 1 : 0;

/**
 * 한 경기(10행)를 상태에 적용하고 결과 행을 돌려준다(_apply_mmr_game).
 * 10명의 경기 전 MMR을 먼저 모두 떠 둔 뒤 계산해야 상대 MMR이 같은 경기의 갱신값에 오염되지 않는다.
 */
export const applyMatch = (
  features: readonly MmrFeatureRow[],
  state: MmrState,
  baseline: MmrBaseline,
): MmrResultRow[] => {
  const rows = [...features].sort(byPlayerCode);
  const preMmr = new Map<string, number>();
  for (const row of rows) {
    preMmr.set(
      `${row.player_code}:${row.position}`,
      state.ensure(row.player_code, row.position).mmr,
    );
  }

  const computed = rows.map((row) => {
    const current = preMmr.get(`${row.player_code}:${row.position}`) as number;
    const opponent = rows.find(
      (other) => other.position === row.position && other.player_code !== row.player_code,
    );
    const opponentMmr = opponent
      ? (preMmr.get(`${opponent.player_code}:${row.position}`) ?? INITIAL_MMR)
      : INITIAL_MMR;

    const expected = expectedPerformance(current, opponentMmr);
    const actual = Number.isNaN(row.game_impact_vs_opponent)
      ? expected
      : row.game_impact_vs_opponent / 100;
    const relative = expected > 0 ? actual / expected : 1;
    const personal = personalFactor(row, baseline);
    const final = personal * relative ** GAMMA;
    const k = kFactor(current);

    let delta: number;
    if (row.game_result === 1) {
      delta = BASE_WIN * final * k;
      delta = clip(Math.max(delta, MIN_ABS_CHANGE), MIN_ABS_CHANGE, MAX_CHANGE);
    } else {
      delta = BASE_LOSS * final * k;
      delta = clip(Math.min(delta, -MIN_ABS_CHANGE), MIN_CHANGE, -MIN_ABS_CHANGE);
    }
    if (!Number.isFinite(delta)) {
      throw new MmrMatchError(`mmr_change is not finite for ${row.replay_code}/${row.player_code}`);
    }
    const change = roundHalfAwayFromZero(delta);

    return {
      ...row,
      pre_game_pos_mmr: current,
      expected_score: expected,
      actual_score: actual,
      relative_factor: relative,
      personal_factor: personal,
      final_factor: final,
      mmr_change: change,
      pos_cumulative_mmr: current + change,
      total_mmr: INITIAL_MMR,
    };
  });

  for (const result of computed) {
    const position = state.ensure(result.player_code, result.position);
    position.mmr = result.pos_cumulative_mmr;
    position.games += 1;
    if (result.game_result === 1) position.wins += 1;
    result.total_mmr = state.totalMmr(result.player_code);
  }
  return computed;
};
