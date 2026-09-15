import { describe, test, expect } from '@jest/globals';
import { decideMatchTeams, decideSide } from '../services/competitionAssign.js';
import {
  AssignedMatchRow,
  SideDecision,
  SideStats,
  StandingMatchRow,
} from '../types/competition.js';
import {
  foldHeadToHead,
  foldOpponentRecords,
  foldStandings,
  foldTeamTotals,
} from '../services/competitionRecord.js';

const team = (teamId: number): SideDecision => ({ kind: 'team', teamId });
const mercenary: SideDecision = { kind: 'mercenary' };
const undecided: SideDecision = { kind: 'undecided' };

describe('decideSide — 한 진영의 귀속 판정', () => {
  const cases: [name: string, teamIds: (number | null)[], expected: SideDecision][] = [
    ['로스터 5명 전원 같은 팀', [1, 1, 1, 1, 1], team(1)],
    ['4명 + 용병 1명', [1, 1, 1, 1, null], team(1)],
    ['3명 + 용병 2명 (과반 기준)', [1, 1, 1, null, null], team(1)],
    ['2명뿐이면 미배정', [1, 1, null, null, null], undecided],
    ['1명뿐이면 미배정', [1, null, null, null, null], undecided],
    ['로스터 소속 0명이면 용병전', [null, null, null, null, null], mercenary],
    ['두 팀이 섞여 어느 쪽도 3명이 안 되면 미배정', [1, 1, 2, 2, null], undecided],
    ['다른 팀원이 섞여도 3명이면 확정', [1, 1, 1, 2, null], team(1)],
  ];

  test.each(cases)('%s', (_name, teamIds, expected) => {
    expect(decideSide(teamIds)).toEqual(expected);
  });
});

describe('decideMatchTeams — 양 진영 조합', () => {
  const cases: [name: string, blue: SideDecision, red: SideDecision, expected: unknown][] = [
    ['서로 다른 팀', team(1), team(2), { blueTeamId: 1, redTeamId: 2 }],
    ['팀 vs 용병전', team(1), mercenary, { blueTeamId: 1, redTeamId: null }],
    ['용병전 vs 팀', mercenary, team(2), { blueTeamId: null, redTeamId: 2 }],
    ['같은 팀 양쪽', team(1), team(1), null],
    ['양쪽 용병전', mercenary, mercenary, null],
    ['한쪽 미배정', team(1), undecided, null],
    ['양쪽 미배정', undecided, undecided, null],
  ];

  test.each(cases)('%s', (_name, blue, red, expected) => {
    expect(decideMatchTeams(blue, red)).toEqual(expected);
  });
});

const row = (
  customMatchId: string,
  gameType: string,
  blueTeamId: number,
  redTeamId: number,
  winnerTeamId: number | null,
): AssignedMatchRow => ({
  customMatchId,
  gameType,
  date: new Date('2026-08-01T00:00:00Z'),
  blueTeamId,
  redTeamId,
  winnerTeamId,
});

describe('foldOpponentRecords — 상대 팀별 전적', () => {
  const rows = [
    row('m1', '2', 1, 2, 1),
    row('m2', '2', 2, 1, 1),
    row('m3', '3', 1, 2, 2),
    row('m4', '2', 1, 3, 3),
    row('m5', '2', 3, 4, 3), // 기준 팀이 없는 경기
  ];

  test('진영과 무관하게 상대별로 묶고 유형별로 나눈다', () => {
    const byOpponent = foldOpponentRecords(rows, 1);

    expect([...byOpponent.keys()].sort()).toEqual([2, 3]);
    expect(byOpponent.get(2)).toEqual({
      scrim: { games: 2, win: 2, lose: 0 },
      main: { games: 1, win: 0, lose: 1 },
    });
    expect(byOpponent.get(3)).toEqual({
      scrim: { games: 1, win: 0, lose: 1 },
      main: { games: 0, win: 0, lose: 0 },
    });
  });

  test('승자를 못 찾은 경기는 판수만 센다', () => {
    expect(foldOpponentRecords([row('m1', '2', 1, 2, null)], 1).get(2)).toEqual({
      scrim: { games: 1, win: 0, lose: 0 },
      main: { games: 0, win: 0, lose: 0 },
    });
  });

  test('일반내전(1)은 스크림·본경기 어느 쪽에도 안 들어간다', () => {
    expect(foldOpponentRecords([row('m1', '1', 1, 2, 1)], 1).get(2)).toEqual({
      scrim: { games: 0, win: 0, lose: 0 },
      main: { games: 0, win: 0, lose: 0 },
    });
  });
});

describe('foldHeadToHead — 두 팀 맞대결', () => {
  const rows = [
    row('m1', '2', 1, 2, 1),
    row('m2', '2', 2, 1, 2),
    row('m3', '3', 1, 2, 1),
    row('m4', '2', 1, 3, 1),
  ];

  test('teamA 관점의 승패와 해당 경기만 반환한다', () => {
    const { record, matches } = foldHeadToHead(rows, 1, 2);

    expect(record).toEqual({
      scrim: { games: 2, win: 1, lose: 1 },
      main: { games: 1, win: 1, lose: 0 },
    });
    expect(matches.map((m) => m.customMatchId)).toEqual(['m1', 'm2', 'm3']);
  });

  test('관점을 뒤집으면 승패가 뒤집힌다', () => {
    expect(foldHeadToHead(rows, 2, 1).record).toEqual({
      scrim: { games: 2, win: 1, lose: 1 },
      main: { games: 1, win: 0, lose: 1 },
    });
  });
});

const stats = (kill: number, death: number, assist: number): SideStats => ({ kill, death, assist });

const standingRow = (
  customMatchId: string,
  gameType: string,
  blueTeamId: number,
  redTeamId: number,
  winnerTeamId: number | null,
  blue: SideStats = stats(0, 0, 0),
  red: SideStats = stats(0, 0, 0),
): StandingMatchRow => ({
  ...row(customMatchId, gameType, blueTeamId, redTeamId, winnerTeamId),
  blue,
  red,
});

describe('foldTeamTotals — 상대를 가리지 않은 팀 전체 전적', () => {
  test('양 진영을 모두 세고 유형별로 나눈다', () => {
    const totals = foldTeamTotals([
      row('m1', '2', 1, 2, 1),
      row('m2', '3', 2, 1, 2),
      row('m3', '2', 1, 3, null),
    ]);

    expect(totals.get(1)).toEqual({
      scrim: { games: 2, win: 1, lose: 0 },
      main: { games: 1, win: 0, lose: 1 },
    });
    expect(totals.get(3)).toEqual({
      scrim: { games: 1, win: 0, lose: 0 },
      main: { games: 0, win: 0, lose: 0 },
    });
  });
});

describe('foldStandings — 대회 순위표', () => {
  const teams = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
    { id: 3, name: 'C' },
    { id: 4, name: 'D' },
  ];
  const rows = [
    standingRow('m1', '2', 1, 2, 1, stats(10, 5, 20), stats(5, 10, 8)),
    standingRow('m2', '2', 3, 2, 3, stats(12, 0, 6), stats(4, 12, 6)),
    standingRow('m3', '3', 2, 4, 4, stats(3, 9, 4), stats(9, 3, 12)),
  ];

  test('승률·승·패가 같으면 등수를 공유하고 다음 팀은 자기 자리 번호를 받는다', () => {
    const { scrim } = foldStandings(teams, rows);

    expect(scrim.map((team) => [team.name, team.rank])).toEqual([
      ['A', 1],
      ['C', 1],
      ['B', 3],
      ['D', 4],
    ]);
  });

  test('한 판도 안 뛴 팀은 지기만 한 팀보다 아래에서 같은 등수를 나눈다', () => {
    const { main } = foldStandings(teams, rows);

    expect(main.map((team) => [team.name, team.rank])).toEqual([
      ['D', 1],
      ['B', 2],
      ['A', 3],
      ['C', 3],
    ]);
    expect(main.find((team) => team.name === 'A')).toMatchObject({
      games: 0,
      win: 0,
      lose: 0,
      winRate: 0,
      avgKda: 0,
    });
  });

  test('스크림과 본경기는 따로 매긴다', () => {
    const { scrim, main } = foldStandings(teams, rows);

    expect(scrim.find((team) => team.name === 'D')?.games).toBe(0);
    expect(main.map((team) => [team.name, team.rank, team.games])).toEqual([
      ['D', 1, 1],
      ['B', 2, 1],
      ['A', 3, 0],
      ['C', 3, 0],
    ]);
  });

  test('승률은 퍼센트 소수 둘째 자리, KDA는 (킬+어시)/데스', () => {
    const { scrim } = foldStandings(teams, [
      ...rows,
      standingRow('m4', '2', 2, 1, 2, stats(6, 3, 3), stats(3, 6, 3)),
    ]);
    const teamA = scrim.find((team) => team.name === 'A');
    const teamB = scrim.find((team) => team.name === 'B');

    expect(teamA).toMatchObject({ games: 2, win: 1, lose: 1, winRate: 50, avgKda: 3.27 });
    expect(teamB).toMatchObject({ games: 3, win: 1, lose: 2, winRate: 33.33 });
  });

  test('데스가 0이면 KDA는 9999', () => {
    const { scrim } = foldStandings(teams, rows);

    expect(scrim.find((team) => team.name === 'C')?.avgKda).toBe(9999);
  });

  test('승자를 못 찾은 경기는 판수만 세고 승패는 비운다', () => {
    const { scrim } = foldStandings(teams, [standingRow('m9', '2', 1, 2, null)]);

    expect(scrim.find((team) => team.name === 'A')).toMatchObject({
      games: 1,
      win: 0,
      lose: 0,
      winRate: 0,
    });
    expect(scrim.find((team) => team.name === 'B')).toMatchObject({ games: 1, win: 0, lose: 0 });
  });

  test('일반내전(1)은 어느 순위표에도 들어가지 않는다', () => {
    const { scrim, main } = foldStandings(teams, [standingRow('m9', '1', 1, 2, 1)]);

    expect(scrim.every((team) => team.games === 0)).toBe(true);
    expect(main.every((team) => team.games === 0)).toBe(true);
  });
});
