/**
 * 팀 vs 팀 전적 집계의 순수 로직. 양 진영이 모두 팀에 귀속된 경기만 들어온다
 * (용병전 = team_id NULL은 호출자가 걸러낸다).
 */

export interface AssignedMatchRow {
  customMatchId: string;
  gameType: string;
  date: Date;
  blueTeamId: number;
  redTeamId: number;
  winnerTeamId: number | null;
}

export interface RecordCount {
  games: number;
  win: number;
  lose: number;
}

export interface TeamRecordSplit {
  scrim: RecordCount;
  main: RecordCount;
}

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
