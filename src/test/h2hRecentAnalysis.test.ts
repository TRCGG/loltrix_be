import { describe, test, expect } from '@jest/globals';
import {
  buildRecentAnalysis,
  byPlayedDateDesc,
  recentWindow,
  MetricSource,
  RecentAnalysisRow,
} from '../services/h2hRecentAnalysis.js';

const KST = '+09:00';
const at = (iso: string) => new Date(`${iso}${KST}`);

const source = (over: Partial<MetricSource> = {}): MetricSource => ({
  gameDuration: 1800,
  minionsKilled: 150,
  neutralMinionsKilled: 0,
  damageToChampions: 18000,
  goldEarned: 12000,
  exp: 15000,
  visionScore: 30,
  wardsKilled: 6,
  timeSpentDead: 90,
  takedownsBefore15Min: 2,
  jungleCsEnemy: 12,
  healOnTeammates: 0,
  shieldOnTeammates: 0,
  ...over,
});

const row = (
  matchId: string,
  playedDate: Date,
  over: Partial<Omit<RecentAnalysisRow, 'matchId' | 'playedDate'>> = {},
): RecentAnalysisRow => ({
  matchId,
  playedDate,
  myResult: 'W',
  myLane: 'MID',
  oppoLane: 'MID',
  mine: source(),
  oppo: source(),
  ...over,
});

const asOf = at('2026-09-10T15:00:00');
const window = recentWindow(asOf, 30);
const analyze = (rows: RecentAnalysisRow[]) => buildRecentAnalysis(rows, asOf);

describe('recentWindow — 요청 시각 기준 정확히 N일', () => {
  test('30일 전 같은 시각이 하한, 요청 시각이 상한 (월 길이와 무관)', () => {
    expect(window.from.toISOString()).toBe(at('2026-08-11T15:00:00').toISOString());
    expect(window.to).toBe(asOf);
    const march = recentWindow(at('2026-03-05T00:00:00'), 30);
    expect(march.from.toISOString()).toBe(at('2026-02-03T00:00:00').toISOString());
  });
});

describe('buildRecentAnalysis — 기간 창과 표본', () => {
  test('하한·상한은 포함, 직전·미래는 제외', () => {
    const rows = [
      row('edge-from', at('2026-08-11T15:00:00')),
      row('before', at('2026-08-11T14:59:59')),
      row('edge-to', asOf),
      row('future', at('2026-09-10T15:00:01')),
    ];
    const out = analyze(rows);
    expect(out.games).toBe(2);
    expect(out.sample.map((s) => s.matchId)).toEqual(['edge-to', 'edge-from']);
  });

  test('조건에 맞는 경기 중 최신 10개만 sample, games는 창 전체', () => {
    const rows = Array.from({ length: 13 }, (_, i) =>
      row(`m${i}`, at(`2026-09-0${(i % 9) + 1}T10:00:00`), { myResult: i % 3 === 0 ? 'L' : 'W' }),
    );
    const out = analyze(rows);
    expect(out.games).toBe(13);
    expect(out.wins + out.losses).toBe(13);
    expect(out.sample).toHaveLength(10);
    expect(out.sampleLimit).toBe(10);
    expect(out.lanes[0].games).toBe(13);
    expect(out.lanes[0].matchIds).toHaveLength(10);
    expect(out.lanes[0].metrics[0].perGame).toHaveLength(10);
  });

  test('같은 시각은 matchId 큰 쪽이 최신 (SQL ASC 정렬의 역순)', () => {
    const t = at('2026-09-01T10:00:00');
    const rows = [row('b', t), row('a', t), row('c', t)];
    expect([...rows].sort(byPlayedDateDesc).map((r) => r.matchId)).toEqual(['c', 'b', 'a']);
    expect(analyze(rows).sample.map((s) => s.matchId)).toEqual(['c', 'b', 'a']);
  });

  test('days 에코는 실제 창과 같은 값에서 나온다', () => {
    const out = buildRecentAnalysis([], asOf, 7);
    expect(out.days).toBe(7);
    expect(out.from.toISOString()).toBe(at('2026-09-03T15:00:00').toISOString());
  });

  test('창 밖 경기는 0건이면 빈 표본', () => {
    const out = analyze([row('old', at('2026-07-01T10:00:00'))]);
    expect(out).toMatchObject({ games: 0, wins: 0, losses: 0, sample: [], lanes: [] });
  });
});

describe('buildRecentAnalysis — 포지션별 맞라인 분리', () => {
  test('다른 포지션 경기는 lanes에 안 들어가고, 포지션끼리 섞이지 않는다', () => {
    const rows = [
      row('mid1', at('2026-09-01T10:00:00'), { mine: source({ minionsKilled: 300 }) }),
      row('mid2', at('2026-09-02T10:00:00')),
      row('top1', at('2026-09-03T10:00:00'), { myLane: 'TOP', oppoLane: 'TOP', myResult: 'L' }),
      row('cross', at('2026-09-04T10:00:00'), { myLane: 'MID', oppoLane: 'TOP' }),
    ];
    const out = analyze(rows);
    expect(out.games).toBe(4);
    expect(out.lanes.map((l) => l.lane)).toEqual(['MID', 'TOP']);
    const mid = out.lanes[0];
    expect(mid).toMatchObject({ games: 2, wins: 2, losses: 0 });
    expect(mid.matchIds).toEqual(['mid2', 'mid1']);
    const cs = mid.metrics.find((m) => m.key === 'csPerMin')!;
    expect(cs.myAvg).toBe(7.5); // (10 + 5) / 2
    expect(out.lanes[1]).toMatchObject({ lane: 'TOP', games: 1, wins: 0, losses: 1 });
  });

  test('판수 동률이면 마지막 맞대결이 최근인 포지션이 먼저', () => {
    const rows = [
      row('top', at('2026-09-05T10:00:00'), { myLane: 'TOP', oppoLane: 'TOP' }),
      row('mid', at('2026-09-01T10:00:00')),
    ];
    expect(analyze(rows).lanes.map((l) => l.lane)).toEqual(['TOP', 'MID']);
  });

  test('상대 정글 CS는 정글 맞라인에만 있다', () => {
    const rows = [
      row('jug', at('2026-09-05T10:00:00'), { myLane: 'JUG', oppoLane: 'JUG' }),
      row('mid', at('2026-09-01T10:00:00')),
    ];
    const out = analyze(rows);
    const keysOf = (lane: string) =>
      out.lanes.find((l) => l.lane === lane)!.metrics.map((m) => m.key);
    expect(keysOf('JUG')).toContain('jungleCsEnemyPerMin');
    expect(keysOf('MID')).not.toContain('jungleCsEnemyPerMin');
  });
});

describe('buildRecentAnalysis — 지표 유효성·방향', () => {
  const metric = (rows: RecentAnalysisRow[], key: string) =>
    analyze(rows).lanes[0].metrics.find((m) => m.key === key)!;

  test('game_duration 0·NULL, 원천 NULL은 유효 표본에서 빠지고 진짜 0은 남는다', () => {
    const rows = [
      row('ok', at('2026-09-01T10:00:00')),
      row('dur0', at('2026-09-02T10:00:00'), { mine: source({ gameDuration: 0 }) }),
      row('durNull', at('2026-09-03T10:00:00'), { oppo: source({ gameDuration: null }) }),
      row('csNull', at('2026-09-04T10:00:00'), { mine: source({ minionsKilled: null }) }),
      row('zero', at('2026-09-05T10:00:00'), {
        mine: source({ minionsKilled: 0, neutralMinionsKilled: 0 }),
      }),
    ];
    const cs = metric(rows, 'csPerMin');
    expect(cs.validGames).toBe(2);
    expect(cs.perGame).toHaveLength(5);
    expect(cs.perGame.find((g) => g.matchId === 'zero')).toEqual({
      matchId: 'zero',
      mine: 0,
      oppo: 5,
    });
    expect(cs.perGame.find((g) => g.matchId === 'csNull')!.mine).toBeNull();
    expect(cs.behind).toBe(1);
    expect(cs.tie).toBe(1);
    // dpm은 csNull 경기도 유효 — 지표별로 따로 센다
    expect(metric(rows, 'dpm').validGames).toBe(3);
  });

  test('0.01 미만 차이는 동률이 아니다 — 비교는 원값, 반올림은 출력만', () => {
    const rows = [
      row('a', at('2026-09-01T10:00:00'), {
        mine: source({ minionsKilled: 150, neutralMinionsKilled: 0 }),
        oppo: source({ minionsKilled: 150, neutralMinionsKilled: 0, gameDuration: 1801 }),
      }),
    ];
    const cs = metric(rows, 'csPerMin');
    expect(cs.perGame[0]).toEqual({ matchId: 'a', mine: 5, oppo: 5 });
    expect([cs.ahead, cs.tie, cs.behind]).toEqual([1, 0, 0]);
  });

  test('평균 차이는 유효 경기의 산술 평균이고 소수 2자리', () => {
    const rows = [
      row('a', at('2026-09-01T10:00:00'), { mine: source({ damageToChampions: 21000 }) }), // 700 vs 600
      row('b', at('2026-09-02T10:00:00'), { mine: source({ damageToChampions: 18100 }) }), // 603.33 vs 600
      row('c', at('2026-09-03T10:00:00'), { oppo: source({ damageToChampions: 24000 }) }), // 600 vs 800
    ];
    const dpm = metric(rows, 'dpm');
    expect(dpm).toMatchObject({ validGames: 3, myAvg: 634.44, oppoAvg: 666.67, diff: -32.22 });
    expect([dpm.ahead, dpm.tie, dpm.behind]).toEqual([2, 0, 1]);
  });

  test('사망 시간 비율은 낮은 쪽이 ahead이고 단위는 %p', () => {
    const rows = [
      row('a', at('2026-09-01T10:00:00'), { mine: source({ timeSpentDead: 36 }) }), // 2% vs 5%
      row('b', at('2026-09-02T10:00:00'), { mine: source({ timeSpentDead: 180 }) }), // 10% vs 5%
      row('c', at('2026-09-03T10:00:00')), // 5% vs 5%
    ];
    const dead = metric(rows, 'deadTimePct');
    expect(dead).toMatchObject({ myAvg: 5.67, oppoAvg: 5, diff: 0.67 });
    expect([dead.ahead, dead.tie, dead.behind]).toEqual([1, 1, 1]);
  });

  test('한 경기가 평균을 뒤집어도 다수 경기 방향은 그대로 드러난다', () => {
    const rows = [
      row('a', at('2026-09-01T10:00:00'), { mine: source({ minionsKilled: 160 }) }), // +0.33
      row('b', at('2026-09-02T10:00:00'), { mine: source({ minionsKilled: 160 }) }), // +0.33
      row('c', at('2026-09-03T10:00:00'), { mine: source({ minionsKilled: 60 }) }), // -3
    ];
    const cs = metric(rows, 'csPerMin');
    expect(cs.diff).toBeLessThan(0);
    expect(cs.ahead).toBe(2);
    expect(cs.behind).toBe(1);
  });

  test('회복·보호막은 합산, 15분 전 킬 관여는 원값 그대로', () => {
    const rows = [
      row('a', at('2026-09-01T10:00:00'), {
        mine: source({ healOnTeammates: 600, shieldOnTeammates: 300, takedownsBefore15Min: 4 }),
      }),
    ];
    expect(metric(rows, 'healShieldPerMin').perGame[0].mine).toBe(30);
    expect(metric(rows, 'takedownsBefore15').perGame[0]).toEqual({
      matchId: 'a',
      mine: 4,
      oppo: 2,
    });
  });
});
