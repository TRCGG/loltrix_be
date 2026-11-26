import { MMR_POSITIONS } from './mmrBaseline.js';
import { MmrResultRow } from './mmrFormula.js';
import { kahanSum, roundNumpy } from './mmrRounding.js';

/** "마지막 결과"를 고르는 순서. replay_code는 Python 문자열 정렬(코드포인트)과 같게 비교한다. */
export const compareByPlayedAt = (
  a: { played_at: Date; replay_code: string },
  b: { played_at: Date; replay_code: string },
): number => {
  const diff = a.played_at.getTime() - b.played_at.getTime();
  if (diff !== 0) return diff;
  return a.replay_code < b.replay_code ? -1 : a.replay_code > b.replay_code ? 1 : 0;
};

// ── 결과 행 저장 형식 ──

/** 결과 테이블의 실수 컬럼. 저장할 때만 numpy 방식으로 둘째 자리 반올림한다. */
const RESULT_FLOAT_COLUMNS = [
  'game_duration',
  'gold_per_min',
  'dpm',
  'damage_taken_per_min',
  'cc_time_per_min',
  'kda',
  'damage_taken_per_death',
  'damage_dealt_per_death',
  'raw_game_impact',
  'game_impact',
  'game_impact_winloss_norm',
  'game_n_person_contribution',
  'game_impact_vs_opponent',
  'expected_score',
  'actual_score',
  'relative_factor',
  'personal_factor',
  'final_factor',
] as const;

const RESULT_INTEGER_COLUMNS = [
  'kills',
  'deaths',
  'assists',
  'gold',
  'cc_time',
  'damage_to_champions',
  'damage_taken',
  'vision_score',
  'vision_bought',
  'penta_kills',
  'pre_game_pos_mmr',
  'mmr_change',
  'pos_cumulative_mmr',
  'total_mmr',
] as const;

export interface StoredResultRow {
  guild_id: string;
  season: string;
  replay_code: string;
  player_code: string;
  champion_id: string | null;
  team: string;
  position: string;
  played_at: Date;
  game_result: number;
  baseline_season: string;
  baseline_version: string;
  [column: string]: string | number | Date | null;
}

const toNullable = (value: number): number | null => (Number.isNaN(value) ? null : value);

export const toStoredResultRow = (
  row: MmrResultRow,
  baseline: { season: string; baselineVersion: string },
): StoredResultRow => {
  const out: StoredResultRow = {
    guild_id: row.guild_id,
    season: row.season,
    replay_code: row.replay_code,
    player_code: row.player_code,
    champion_id: row.champion_id,
    team: row.team,
    position: row.position,
    played_at: row.played_at,
    game_result: row.game_result,
    baseline_season: baseline.season,
    baseline_version: baseline.baselineVersion,
  };
  const values = row as unknown as Record<string, number>;
  for (const column of RESULT_INTEGER_COLUMNS) out[column] = toNullable(values[column]);
  for (const column of RESULT_FLOAT_COLUMNS)
    out[column] = toNullable(roundNumpy(values[column], 2));
  return out;
};

// ── summary 재구성 ──

export interface SummaryInputRow {
  player_code: string;
  position: string;
  game_result: number;
  played_at: Date;
  replay_code: string;
  pos_cumulative_mmr: number;
  total_mmr: number;
}

export interface SummaryRow {
  player_code: string;
  total_mmr: number;
  total_games: number;
  overall_winrate: number;
  [positionColumn: string]: string | number | null;
}

const winrate = (wins: number, games: number): number => roundNumpy((wins / games) * 100, 2);

/** make_summary_df_wide: 결과 행만으로 선수 summary를 다시 만든다. 결과가 없는 선수는 행이 없다. */
export const buildSummaries = (rows: readonly SummaryInputRow[]): SummaryRow[] => {
  const byPlayer = new Map<string, SummaryInputRow[]>();
  for (const row of rows) {
    const list = byPlayer.get(row.player_code) ?? [];
    list.push(row);
    byPlayer.set(row.player_code, list);
  }

  const summaries: SummaryRow[] = [];
  for (const [playerCode, list] of byPlayer) {
    const ordered = [...list].sort(compareByPlayedAt);
    const wins = ordered.filter((row) => row.game_result === 1).length;
    const summary: SummaryRow = {
      player_code: playerCode,
      total_mmr: ordered[ordered.length - 1].total_mmr,
      total_games: ordered.length,
      overall_winrate: winrate(wins, ordered.length),
    };
    for (const position of MMR_POSITIONS) {
      const key = position.toLowerCase();
      const games = ordered.filter((row) => row.position === position);
      if (games.length === 0) {
        summary[`${key}_mmr`] = null;
        summary[`${key}_winrate`] = null;
        summary[`${key}_games`] = 0;
        continue;
      }
      summary[`${key}_mmr`] = games[games.length - 1].pos_cumulative_mmr;
      summary[`${key}_winrate`] = winrate(
        games.filter((row) => row.game_result === 1).length,
        games.length,
      );
      summary[`${key}_games`] = games.length;
    }
    summaries.push(summary);
  }
  return summaries;
};

// ── 포지션 리포트 (gmok_mmr report.py) ──

export const REPORT_METRICS = [
  'game_impact',
  'game_n_person_contribution',
  'game_impact_vs_opponent',
  'damage_taken_per_min',
  'dpm',
  'gold_per_min',
  'damage_dealt_per_death',
  'damage_taken_per_death',
  'vision_score',
  'cc_time_per_min',
  'kda',
  'cs_per_min',
  'exp_per_min',
] as const;
type ReportMetric = (typeof REPORT_METRICS)[number];

type Percentiles = Record<
  | 'dpm'
  | 'damage_dealt_per_death'
  | 'cs_per_min'
  | 'gold_per_min'
  | 'exp_per_min'
  | 'kda'
  | 'game_n_person_contribution'
  | 'game_impact_vs_opponent',
  number
>;
const STYLE_METRICS: ReadonlyArray<keyof Percentiles> = [
  'dpm',
  'damage_dealt_per_death',
  'cs_per_min',
  'gold_per_min',
  'exp_per_min',
  'kda',
  'game_n_person_contribution',
  'game_impact_vs_opponent',
];
type StyleRule = [string, (p: Percentiles) => boolean];

const BASE_STYLE_RULES: StyleRule[] = [
  ['불도저', (p) => p.dpm >= 75 && p.damage_dealt_per_death <= 35],
  ['생존형 딜러', (p) => p.dpm >= 75 && p.damage_dealt_per_death >= 75],
  ['성장형(파밍 중심)', (p) => p.cs_per_min >= 75 && (p.gold_per_min >= 75 || p.exp_per_min >= 75)],
  ['팀파이트 캐리형', (p) => p.kda >= 75 && p.game_impact_vs_opponent >= 75],
  [
    '밸런스형(올라운더)',
    (p) => p.game_n_person_contribution >= 70 && p.game_impact_vs_opponent >= 60,
  ],
  ['운영형', (p) => (p.cs_per_min >= 70 || p.gold_per_min >= 70) && p.kda <= 40],
];

const POSITION_STYLE_RULES: Record<string, StyleRule[]> = {
  TOP: [
    [
      '사이드 운영형 탑',
      (p) => p.cs_per_min >= 70 && p.gold_per_min >= 65 && p.game_impact_vs_opponent >= 60,
    ],
    ['한타 개입형 탑', (p) => p.dpm >= 65 && p.kda >= 65 && p.game_n_person_contribution >= 65],
  ],
  JUG: [
    [
      '갱킹형 정글러',
      (p) => p.kda >= 70 && p.game_n_person_contribution >= 70 && p.game_impact_vs_opponent >= 60,
    ],
    [
      '오브젝트/주도권형 정글러',
      (p) =>
        p.game_impact_vs_opponent >= 75 && p.game_n_person_contribution >= 65 && p.cs_per_min >= 55,
    ],
    ['파밍형 정글러', (p) => p.cs_per_min >= 75 && p.gold_per_min >= 70 && p.exp_per_min >= 70],
  ],
  MID: [
    ['로밍형 미드', (p) => p.kda >= 70 && p.game_n_person_contribution >= 70 && p.cs_per_min <= 50],
    [
      '라인 캐리형 미드',
      (p) => p.game_impact_vs_opponent >= 70 && p.dpm >= 70 && p.cs_per_min >= 55,
    ],
  ],
  ADC: [
    [
      '하드 캐리형 원딜',
      (p) => p.dpm >= 75 && p.gold_per_min >= 70 && p.damage_dealt_per_death >= 70,
    ],
    [
      '라인전 우위형 원딜',
      (p) => p.game_impact_vs_opponent >= 70 && p.cs_per_min >= 65 && p.dpm >= 65,
    ],
  ],
  SUP: [
    [
      '팀 기여형 서포터',
      (p) => p.game_n_person_contribution >= 70 && p.kda >= 65 && p.game_impact_vs_opponent >= 60,
    ],
    ['교전 개시형 서포터', (p) => p.game_n_person_contribution >= 70 && p.dpm >= 55 && p.kda >= 55],
  ],
};

const MIN_STYLE_GAMES = 20;
const MIN_REFERENCE_USERS = 5;
const NOT_READY = '분류 준비 상태';
const COMPARISON_BASIS = '같은 클랜·포지션 전체';

export type ReportInputRow = Pick<MmrResultRow, 'player_code' | 'position' | ReportMetric>;

interface PositionAggregate {
  playerCode: string;
  position: string;
  games: number;
  means: Record<ReportMetric, number>;
  baseStyle: string;
  positionStyle: string;
  referenceUsers: number;
}

const classify = (percentiles: Percentiles, rules: StyleRule[], fallback: string): string =>
  rules.find(([, rule]) => rule(percentiles))?.[0] ?? fallback;

const percentile = (value: number, population: number[]): number => {
  if (Number.isNaN(value) || population.length === 0) return Number.NaN;
  return (population.filter((item) => item <= value).length / population.length) * 100;
};

/**
 * build_user_position_report + build_position_report_records. 입력은 한 길드·시즌의 전체 결과 행을
 * 경기 순서대로 준 것이어야 한다 — 평균의 합산 순서가 pandas groupby와 같아야 마지막 비트가 맞는다.
 * 반환: player_code → position_report(JSON 실수도 다른 실수 컬럼처럼 numpy 방식 둘째 자리).
 */
export const buildPositionReports = (
  rows: readonly ReportInputRow[],
): Map<string, Record<string, Record<string, unknown>>> => {
  const groups = new Map<string, ReportInputRow[]>();
  for (const row of rows) {
    const key = `${row.player_code}\u0000${row.position}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const aggregates: PositionAggregate[] = [];
  for (const list of groups.values()) {
    const means = {} as Record<ReportMetric, number>;
    for (const metric of REPORT_METRICS) {
      const { sum, count } = kahanSum(list.map((row) => row[metric]));
      means[metric] = count === 0 ? Number.NaN : sum / count;
    }
    aggregates.push({
      playerCode: list[0].player_code,
      position: list[0].position,
      games: list.length,
      means,
      baseStyle: NOT_READY,
      positionStyle: NOT_READY,
      referenceUsers: 0,
    });
  }

  for (const position of new Set(aggregates.map((item) => item.position))) {
    const group = aggregates.filter((item) => item.position === position);
    const reference = group.filter((item) => item.games >= MIN_STYLE_GAMES);
    for (const item of group) item.referenceUsers = reference.length;
    if (reference.length < MIN_REFERENCE_USERS) continue;

    const populations = Object.fromEntries(
      STYLE_METRICS.map((metric) => [
        metric,
        reference.map((item) => item.means[metric]).filter((value) => !Number.isNaN(value)),
      ]),
    ) as Record<keyof Percentiles, number[]>;

    for (const item of reference) {
      const percentiles = Object.fromEntries(
        STYLE_METRICS.map((metric) => [
          metric,
          percentile(item.means[metric], populations[metric]),
        ]),
      ) as Percentiles;
      if (Object.values(percentiles).some((value) => Number.isNaN(value))) continue;
      item.baseStyle = classify(percentiles, BASE_STYLE_RULES, '밸런스형(기본)');
      item.positionStyle = classify(percentiles, POSITION_STYLE_RULES[position] ?? [], NOT_READY);
    }
  }

  const reports = new Map<string, Record<string, Record<string, unknown>>>();
  for (const item of aggregates) {
    const report = reports.get(item.playerCode) ?? {};
    const entry: Record<string, unknown> = {};
    for (const metric of REPORT_METRICS) {
      const mean = item.means[metric];
      entry[metric] = Number.isNaN(mean) ? null : roundNumpy(mean, 2);
    }
    entry.base_style = item.baseStyle;
    entry.position_style = item.positionStyle;
    entry.comparison_basis = COMPARISON_BASIS;
    entry.reference_users = item.referenceUsers;
    report[item.position] = entry;
    reports.set(item.playerCode, report);
  }
  return reports;
};
