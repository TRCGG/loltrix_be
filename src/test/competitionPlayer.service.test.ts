import { jest, describe, test, expect, beforeEach } from '@jest/globals';

/** competitionTeam.service.test와 같은 방식 — await 순서대로 큐에서 하나씩 꺼낸다. */
let queue: unknown[] = [];

const CHAIN_METHODS = ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin', 'groupBy'];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const value = queue.length > 0 ? queue.shift() : [];
    return value instanceof Error
      ? Promise.reject(value).then(resolve, reject)
      : Promise.resolve(value).then(resolve, reject);
  };
  return builder;
};

const executor: Record<string, unknown> = { select: () => makeBuilder() };

const computeStandingsMany = jest.fn<(...args: any[]) => Promise<any>>();

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));
jest.unstable_mockModule('../services/competitionTeam.service.js', () => ({
  competitionTeamService: { computeStandingsMany },
}));

const { CompetitionPlayerService } = await import('../services/competitionPlayer.service.js');

const service = new CompetitionPlayerService();
const GUILD = 'guild-1';
const MAIN = 'PLR_main';
const SUB = 'PLR_sub';

const competitionRow = (extra: Record<string, unknown> = {}) => ({
  id: 7,
  guildId: GUILD,
  name: '멸망전 1회',
  season: 'S13',
  status: 'IN_PROGRESS',
  approvalRequired: true,
  createDate: new Date('2026-08-01T00:00:00Z'),
  closeDate: null,
  ...extra,
});

const rosterRow = (extra: Record<string, unknown> = {}) => ({
  competitionId: 7,
  teamId: 3,
  position: 'MID',
  teamName: '1팀',
  captainPlayerCode: null,
  ...extra,
});

const playedRow = (extra: Record<string, unknown> = {}) => ({
  competitionId: 7,
  customMatchId: 'm1',
  gameResult: '승',
  kill: 5,
  death: 2,
  assist: 5,
  ...extra,
});

/** [부캐 링크, 링크된 계정, 로스터, 신청, 참가 기록, 대회] 순서 */
const setQueue = (parts: {
  link?: unknown[];
  linked?: unknown[];
  rosters?: unknown[];
  applications?: unknown[];
  played?: unknown[];
  competitions?: unknown[];
}) => {
  queue = [
    parts.link ?? [],
    parts.linked ?? [],
    parts.rosters ?? [],
    parts.applications ?? [],
    parts.played ?? [],
    parts.competitions ?? [],
  ];
};

beforeEach(() => {
  queue = [];
  computeStandingsMany.mockResolvedValue(new Map());
});

describe('선수의 대회 목록', () => {
  test('로스터에만 올라도 목록에 나온다', async () => {
    setQueue({ rosters: [rosterRow()], competitions: [competitionRow()] });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item).toMatchObject({
      competitionId: 7,
      name: '멸망전 1회',
      team: { id: 3, name: '1팀', position: 'MID', isCaptain: false },
      applicationStatus: null,
      record: { games: 0, win: 0, lose: 0, winRate: 0 },
      recent: [],
    });
  });

  test('신청만 하고 뽑히지 않아도 목록에 나온다', async () => {
    setQueue({
      applications: [{ competitionId: 7, status: 'REJECTED' }],
      competitions: [competitionRow()],
    });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item.team).toBeNull();
    expect(item.applicationStatus).toBe('REJECTED');
    expect(item.teamRank).toEqual({ scrim: null, main: null });
  });

  test('신청·로스터 없이 경기만 뛰어도 목록에 나온다', async () => {
    setQueue({ played: [playedRow({ customMatchId: 'm1' })], competitions: [competitionRow()] });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item.team).toBeNull();
    expect(item.record).toEqual({ games: 1, win: 1, lose: 0, winRate: 100, kda: 5 });
  });

  test('부계정으로 조회해도 본계정과 링크된 부계정을 함께 건다', async () => {
    queue = [[{ account: SUB, mainAccount: MAIN }], [{ account: SUB }]];

    expect(await service.accountCodes(GUILD, SUB)).toEqual([MAIN, SUB]);
  });

  test('링크가 없으면 조회한 코드 하나만 건다', async () => {
    queue = [[], []];

    expect(await service.accountCodes(GUILD, SUB)).toEqual([SUB]);
  });

  test('링크된 부계정으로 뛴 경기도 본인 전적에 합친다', async () => {
    setQueue({
      link: [{ account: SUB, mainAccount: MAIN }],
      linked: [{ account: SUB }],
      played: [
        playedRow({ customMatchId: 'm1' }),
        playedRow({ customMatchId: 'm2', gameResult: '패' }),
      ],
      competitions: [competitionRow()],
    });

    const [item] = await service.listCompetitions(GUILD, SUB);

    expect(item.record).toMatchObject({ games: 2, win: 1, lose: 1, winRate: 50 });
  });

  test('본캐·부캐가 한 경기에 같이 잡혀도 한 판으로 센다', async () => {
    setQueue({
      link: [{ account: SUB, mainAccount: MAIN }],
      linked: [{ account: SUB }],
      played: [playedRow({ customMatchId: 'm1' }), playedRow({ customMatchId: 'm1' })],
      competitions: [competitionRow()],
    });

    const [item] = await service.listCompetitions(GUILD, SUB);

    expect(item.record).toMatchObject({ games: 1, win: 1, lose: 0 });
    expect(item.recent).toEqual(['승']);
  });

  test('최근 결과는 6판까지 최신순으로 자른다', async () => {
    setQueue({
      played: [
        playedRow({ customMatchId: 'm0', gameResult: '패' }),
        ...Array.from({ length: 6 }, (_unused, index) =>
          playedRow({ customMatchId: `m${index + 1}` }),
        ),
      ],
      competitions: [competitionRow()],
    });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item.recent).toEqual(['패', '승', '승', '승', '승', '승']);
    expect(item.record.games).toBe(7);
  });

  test('팀이 있으면 순위표에서 등수를 가져온다', async () => {
    computeStandingsMany.mockResolvedValue(
      new Map([[7, { scrim: [{ teamId: 3, rank: 2 }], main: [{ teamId: 9, rank: 1 }] }]]),
    );
    setQueue({ rosters: [rosterRow()], competitions: [competitionRow()] });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item.teamRank).toEqual({ scrim: 2, main: null });
  });

  test('로스터에 오른 대회 전부를 순위표 조회 한 번으로 묶는다', async () => {
    setQueue({
      rosters: [rosterRow(), rosterRow({ competitionId: 8, teamId: 4 })],
      competitions: [competitionRow(), competitionRow({ id: 8 })],
    });

    await service.listCompetitions(GUILD, MAIN);

    expect(computeStandingsMany).toHaveBeenCalledTimes(1);
    expect(computeStandingsMany).toHaveBeenCalledWith(GUILD, [7, 8]);
  });

  test('팀장이면 isCaptain이 선다', async () => {
    setQueue({
      rosters: [rosterRow({ captainPlayerCode: MAIN })],
      competitions: [competitionRow()],
    });

    const [item] = await service.listCompetitions(GUILD, MAIN);

    expect(item.team?.isCaptain).toBe(true);
  });

  test('얽힌 대회가 없으면 대회 조회 없이 빈 배열', async () => {
    setQueue({});

    expect(await service.listCompetitions(GUILD, MAIN)).toEqual([]);
    expect(computeStandingsMany).not.toHaveBeenCalled();
  });
});
