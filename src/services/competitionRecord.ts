/**
 * 팀 vs 팀 전적 집계의 순수 로직. 양 진영이 모두 팀에 귀속된 경기만 들어온다
 * (용병전 = team_id NULL은 호출자가 걸러낸다).
 */
import {
  AssignedMatchRow,
  CompetitionStandings,
  RecordCount,
  SideStats,
  StandingMatchRow,
  StandingRow,
  TeamRecordSplit,
} from '../types/competition.js';

const emptyCount = (): RecordCount => ({ games: 0, win: 0, lose: 0 });

export const emptySplit = (): TeamRecordSplit => ({ scrim: emptyCount(), main: emptyCount() });

const bucketOf = (split: TeamRecordSplit, gameType: string): RecordCount | null => {
  if (gameType === '2') return split.scrim;
  if (gameType === '3') return split.main;
  return null;
};

const tally = (split: TeamRecordSplit, row: AssignedMatchRow, teamId: number) => {
  const bucket = bucketOf(split, row.gameType);
  if (!bucket) return;
  bucket.games += 1;
  if (row.winnerTeamId === teamId) bucket.win += 1;
  else if (row.winnerTeamId != null) bucket.lose += 1;
};

/** 기준 팀이 뛴 경기를 상대 팀 id별로 접는다. */
export const foldOpponentRecords = (
  rows: AssignedMatchRow[],
  teamId: number,
): Map<number, TeamRecordSplit> => {
  const byOpponent = new Map<number, TeamRecordSplit>();
  for (const row of rows) {
    if (row.blueTeamId !== teamId && row.redTeamId !== teamId) continue;
    const opponentId = row.blueTeamId === teamId ? row.redTeamId : row.blueTeamId;
    const split = byOpponent.get(opponentId) ?? emptySplit();
    tally(split, row, teamId);
    byOpponent.set(opponentId, split);
  }
  return byOpponent;
};

/** teamA 관점의 맞대결 전적 + 해당 경기 목록. */
export const foldHeadToHead = (
  rows: AssignedMatchRow[],
  teamA: number,
  teamB: number,
): { record: TeamRecordSplit; matches: AssignedMatchRow[] } => {
  const record = emptySplit();
  const matches = rows.filter(
    (row) =>
      (row.blueTeamId === teamA && row.redTeamId === teamB) ||
      (row.blueTeamId === teamB && row.redTeamId === teamA),
  );
  for (const row of matches) tally(record, row, teamA);
  return { record, matches };
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** 개인 전적의 승률과 같은 단위(퍼센트, 소수 둘째 자리)로 맞춘다. */
export const winRateOf = (win: number, games: number): number =>
  games === 0 ? 0 : round2((win * 100) / games);

/** 데스 0은 기존 집계 SQL과 같이 9999(퍼펙트)로 표기한다. 경기가 없으면 퍼펙트가 아니라 0이다. */
export const kdaOf = (stats: SideStats & { games?: number }): number => {
  if (stats.games === 0) return 0;
  return stats.death === 0 ? 9999 : round2((stats.kill + stats.assist) / stats.death);
};

/** 상대를 가리지 않은 팀 전체 전적 — 목록 화면이 팀마다 한 줄로 쓴다. */
export const foldTeamTotals = (rows: AssignedMatchRow[]): Map<number, TeamRecordSplit> => {
  const byTeam = new Map<number, TeamRecordSplit>();
  const add = (teamId: number, row: AssignedMatchRow) => {
    const split = byTeam.get(teamId) ?? emptySplit();
    tally(split, row, teamId);
    byTeam.set(teamId, split);
  };
  for (const row of rows) {
    add(row.blueTeamId, row);
    add(row.redTeamId, row);
  }
  return byTeam;
};

interface StandingAccumulator extends RecordCount, SideStats {}

const emptyAccumulator = (): StandingAccumulator => ({
  games: 0,
  win: 0,
  lose: 0,
  kill: 0,
  death: 0,
  assist: 0,
});

/**
 * 판수 유무 → 승률 → 승 → 패 → 이름. 이름까지 보는 건 화면 순서를 매 조회마다 뒤바꾸지 않기 위해서다.
 * 판수 유무를 먼저 보지 않으면 0판 팀이 승률 0으로 계산돼 전패 팀보다 위에 선다.
 * 키가 같은 팀은 같은 등수를 쓰고, 다음 팀은 자기 자리 번호를 받는다(1,1,3).
 */
const played = (row: Omit<StandingRow, 'rank'>): number => (row.games > 0 ? 1 : 0);

const rankRows = (rows: Omit<StandingRow, 'rank'>[]): StandingRow[] => {
  const sorted = [...rows].sort(
    (a, b) =>
      played(b) - played(a) ||
      b.winRate - a.winRate ||
      b.win - a.win ||
      a.lose - b.lose ||
      a.name.localeCompare(b.name),
  );
  let rank = 0;
  let previous = '';
  return sorted.map((row, index) => {
    const key = `${played(row)}|${row.winRate}|${row.win}|${row.lose}`;
    if (key !== previous) {
      rank = index + 1;
      previous = key;
    }
    return { rank, ...row };
  });
};

/** 스크림(2)·본경기(3)를 절대 합치지 않는다 — 두 유형은 서로 다른 순위표다. */
export const foldStandings = (
  teams: { id: number; name: string }[],
  rows: StandingMatchRow[],
): CompetitionStandings => {
  const buckets = {
    scrim: new Map<number, StandingAccumulator>(),
    main: new Map<number, StandingAccumulator>(),
  };
  for (const team of teams) {
    buckets.scrim.set(team.id, emptyAccumulator());
    buckets.main.set(team.id, emptyAccumulator());
  }

  for (const row of rows) {
    const bucket =
      row.gameType === '2' ? buckets.scrim : row.gameType === '3' ? buckets.main : null;
    if (!bucket) continue;
    for (const [teamId, stats] of [
      [row.blueTeamId, row.blue],
      [row.redTeamId, row.red],
    ] as const) {
      const acc = bucket.get(teamId);
      if (!acc) continue;
      acc.games += 1;
      if (row.winnerTeamId === teamId) acc.win += 1;
      else if (row.winnerTeamId != null) acc.lose += 1;
      acc.kill += stats.kill;
      acc.death += stats.death;
      acc.assist += stats.assist;
    }
  }

  const toRows = (bucket: Map<number, StandingAccumulator>) =>
    rankRows(
      teams.map((team) => {
        const acc = bucket.get(team.id) ?? emptyAccumulator();
        return {
          teamId: team.id,
          name: team.name,
          games: acc.games,
          win: acc.win,
          lose: acc.lose,
          winRate: winRateOf(acc.win, acc.games),
          avgKda: kdaOf(acc),
        };
      }),
    );

  return { scrim: toRows(buckets.scrim), main: toRows(buckets.main) };
};
