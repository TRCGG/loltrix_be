import {
  H2hLane,
  H2hLaneAnalysis,
  H2hLaneMetric,
  H2hMetricKey,
  H2hRecentAnalysis,
  H2H_LANES,
} from '../types/h2h.js';

/** 인사이트 표본 기간·상한. 운영 노출률을 본 뒤 조정하는 값이라 상수로 분리 */
export const H2H_RECENT_DAYS = 30;
export const H2H_RECENT_SAMPLE_LIMIT = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 요청 시각 기준 정확히 days일 전 ~ 요청 시각. 달력 월·자정 기준이 아니다 */
export const recentWindow = (asOf: Date, days: number): { from: Date; to: Date } => ({
  from: new Date(asOf.getTime() - days * DAY_MS),
  to: asOf,
});

/** 지표 계산에 쓰는 한쪽 참가자의 원천값. 저장된 파생 컬럼은 누락을 0으로 담을 수 있어 쓰지 않는다 */
export interface MetricSource {
  gameDuration: number | null;
  minionsKilled: number | null;
  neutralMinionsKilled: number | null;
  damageToChampions: number | null;
  goldEarned: number | null;
  exp: number | null;
  visionScore: number | null;
  wardsKilled: number | null;
  timeSpentDead: number | null;
  takedownsBefore15Min: number | null;
  jungleCsEnemy: number | null;
  healOnTeammates: number | null;
  shieldOnTeammates: number | null;
}

export interface RecentAnalysisRow {
  matchId: string;
  playedDate: Date;
  myResult: 'W' | 'L';
  myLane: string;
  oppoLane: string;
  mine: MetricSource;
  oppo: MetricSource;
}

interface MetricDef {
  key: H2hMetricKey;
  lowerIsBetter?: boolean;
  lanes?: readonly H2hLane[];
  value: (s: MetricSource) => number | null;
}

const perMin = (n: number | null, duration: number | null): number | null =>
  n === null || duration === null || duration <= 0 ? null : (n * 60) / duration;

const sum = (a: number | null, b: number | null): number | null =>
  a === null || b === null ? null : a + b;

const METRICS: readonly MetricDef[] = [
  {
    key: 'csPerMin',
    value: (s) => perMin(sum(s.minionsKilled, s.neutralMinionsKilled), s.gameDuration),
  },
  { key: 'dpm', value: (s) => perMin(s.damageToChampions, s.gameDuration) },
  { key: 'goldPerMin', value: (s) => perMin(s.goldEarned, s.gameDuration) },
  { key: 'expPerMin', value: (s) => perMin(s.exp, s.gameDuration) },
  { key: 'visionPerMin', value: (s) => perMin(s.visionScore, s.gameDuration) },
  { key: 'wardsKilledPerMin', value: (s) => perMin(s.wardsKilled, s.gameDuration) },
  {
    key: 'deadTimePct',
    lowerIsBetter: true,
    value: (s) =>
      s.timeSpentDead === null || s.gameDuration === null || s.gameDuration <= 0
        ? null
        : (s.timeSpentDead * 100) / s.gameDuration,
  },
  { key: 'takedownsBefore15', value: (s) => s.takedownsBefore15Min },
  {
    key: 'jungleCsEnemyPerMin',
    lanes: ['JUG'],
    value: (s) => perMin(s.jungleCsEnemy, s.gameDuration),
  },
  {
    key: 'healShieldPerMin',
    value: (s) => perMin(sum(s.healOnTeammates, s.shieldOnTeammates), s.gameDuration),
  },
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * 최신순. 같은 시각이면 matchId 큰 쪽이 최신 — SQL `ORDER BY played_date, custom_match_id`(ASC)의 정확한 역순이어야
 * 스트릭(ASC)과 최근 목록·표본(DESC)이 같은 경기 순서를 본다
 */
export const byPlayedDateDesc = <T extends { playedDate: Date; matchId: string }>(
  a: T,
  b: T,
): number => b.playedDate.getTime() - a.playedDate.getTime() || b.matchId.localeCompare(a.matchId);

/** 비교·평균은 원값으로 하고 반올림은 출력에만 — 0.01 미만 차이가 동률로 뭉개지지 않게 */
const buildMetric = (def: MetricDef, rows: RecentAnalysisRow[]): H2hLaneMetric => {
  const raw = rows.map((r) => ({
    matchId: r.matchId,
    mine: def.value(r.mine),
    oppo: def.value(r.oppo),
  }));
  const valid = raw.filter(
    (g): g is { matchId: string; mine: number; oppo: number } => g.mine !== null && g.oppo !== null,
  );
  const tie = valid.filter((g) => g.mine === g.oppo).length;
  const ahead = valid.filter(
    (g) => g.mine !== g.oppo && g.mine > g.oppo !== !!def.lowerIsBetter,
  ).length;
  const mean = (pick: (g: { mine: number; oppo: number }) => number): number | null =>
    valid.length === 0 ? null : valid.reduce((s, g) => s + pick(g), 0) / valid.length;
  const myAvg = mean((g) => g.mine);
  const oppoAvg = mean((g) => g.oppo);
  const out = (n: number | null): number | null => (n === null ? null : round2(n));
  return {
    key: def.key,
    validGames: valid.length,
    myAvg: out(myAvg),
    oppoAvg: out(oppoAvg),
    diff: myAvg === null || oppoAvg === null ? null : round2(myAvg - oppoAvg),
    ahead,
    tie,
    behind: valid.length - tie - ahead,
    perGame: raw.map((g) => ({ matchId: g.matchId, mine: out(g.mine), oppo: out(g.oppo) })),
  };
};

const isLane = (v: string): v is H2hLane => (H2H_LANES as readonly string[]).includes(v);

/**
 * 인사이트 표본. rows는 이미 포지션·맞라인 필터가 적용된 맞붙은 경기 전체이며,
 * 여기서 기간 창으로 한 번 더 거른다 — period='all'이어도 카드는 최근 창만 본다.
 * played_date는 업로드 시각이라(원본 리플에 경기 시각 없음) 오래된 리플을 오늘 올리면 '최근'에 들어온다.
 */
export const buildRecentAnalysis = (
  rows: RecentAnalysisRow[],
  asOf: Date,
  days: number = H2H_RECENT_DAYS,
  sampleLimit: number = H2H_RECENT_SAMPLE_LIMIT,
): H2hRecentAnalysis => {
  const window = recentWindow(asOf, days);
  const inWindow = rows
    .filter((r) => r.playedDate >= window.from && r.playedDate <= window.to)
    .sort(byPlayedDateDesc);
  const wins = inWindow.filter((r) => r.myResult === 'W').length;

  const byLane = new Map<H2hLane, RecentAnalysisRow[]>();
  inWindow.forEach((r) => {
    if (r.myLane === r.oppoLane && isLane(r.myLane)) {
      byLane.set(r.myLane, [...(byLane.get(r.myLane) ?? []), r]);
    }
  });

  const lanes: H2hLaneAnalysis[] = Array.from(byLane.entries())
    .map(([lane, laneRows]) => {
      const sample = laneRows.slice(0, sampleLimit);
      const laneWins = laneRows.filter((r) => r.myResult === 'W').length;
      return {
        lane,
        games: laneRows.length,
        wins: laneWins,
        losses: laneRows.length - laneWins,
        lastPlayedDate: laneRows[0].playedDate,
        matchIds: sample.map((r) => r.matchId),
        metrics: METRICS.filter((m) => !m.lanes || m.lanes.includes(lane)).map((m) =>
          buildMetric(m, sample),
        ),
      };
    })
    .sort(
      (a, b) =>
        b.games - a.games ||
        b.lastPlayedDate.getTime() - a.lastPlayedDate.getTime() ||
        H2H_LANES.indexOf(a.lane) - H2H_LANES.indexOf(b.lane),
    );

  return {
    days,
    from: window.from,
    to: window.to,
    games: inWindow.length,
    wins,
    losses: inWindow.length - wins,
    sampleLimit,
    sample: inWindow.slice(0, sampleLimit).map((r) => ({
      matchId: r.matchId,
      playedDate: r.playedDate,
      myResult: r.myResult,
      myLane: r.myLane,
      oppoLane: r.oppoLane,
    })),
    lanes,
  };
};
