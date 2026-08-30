import { describe, test, expect } from '@jest/globals';
import { decideMatchTeams, decideSide, SideDecision } from '../services/competitionAssign.js';
import {
  AssignedMatchRow,
  foldHeadToHead,
  foldOpponentRecords,
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
