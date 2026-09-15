import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { BusinessError } from '../types/error.js';

type AsyncFn = (...args: any[]) => Promise<any>;

const assertExists = jest.fn<AsyncFn>();
const getUserGameStatistics = jest.fn<AsyncFn>();
const getChampionStatistics = jest.fn<AsyncFn>();

jest.unstable_mockModule('../services/competition.service.js', () => ({
  competitionService: { assertExists },
}));
jest.unstable_mockModule('../services/statistics.service.js', () => ({
  statisticsService: { getUserGameStatistics, getChampionStatistics },
}));

const { getCompetitionUserStats, getCompetitionChampionStats } = await import(
  '../controllers/competitionStatistics.controller.js'
);

const makeRes = () => {
  const headers: Record<string, string> = {};
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return {
    headers,
    json,
    status,
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  };
};

const makeReq = (query: Record<string, string> = {}) =>
  ({ params: { guildId: 'g1', competitionId: '7' }, query }) as any;

const userRow = {
  playerCode: 'PLR_000001',
  riotName: '홍길동',
  riotNameTag: 'KR1',
  totalCount: 4,
  win: 3,
  lose: 1,
  winRate: 75,
  kda: 4.5,
  kills: 20,
  avgDpm: 620,
  killParticipation: '62.50',
  damageShare: '30.12',
  goldPerMin: '381.40',
  avgVisionScore: '21.50',
  damagePerDeath: '8123.45',
  deadTimePct: '12.30',
  multiKills: { double: 2, triple: 1, quadra: 0, penta: 0 },
};

type Handler = (req: any, res: any, next: any) => Promise<unknown>;

const run = async (handler: Handler, query?: Record<string, string>) => {
  const res = makeRes();
  const next = jest.fn();
  await handler(makeReq(query), res as any, next as any);
  return { res, next };
};

beforeEach(() => {
  jest.clearAllMocks();
  assertExists.mockResolvedValue(undefined);
  getUserGameStatistics.mockResolvedValue({ result: [userRow], totalCount: 3 });
  getChampionStatistics.mockResolvedValue({
    result: [{ champName: '아리', champNameEng: 'Ahri', totalCount: 2 }],
    totalCount: 2,
  });
});

describe('대회 유저 랭킹', () => {
  test('200 + 지표가 실린 목록과 페이지 헤더', async () => {
    const { res } = await run(getCompetitionUserStats, { page: '2', limit: '10' });

    expect(assertExists).toHaveBeenCalledWith('g1', 7);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      message: 'Competition user statistics retrieved successfully',
      data: [userRow],
    });
    expect(res.headers).toEqual({
      'X-Total-Count': '3',
      'X-Page': '2',
      'X-Limit': '10',
      'X-Total-Pages': '1',
    });
  });

  test('gameType 생략 시 스크림·본경기 합산, 기본 50개', async () => {
    await run(getCompetitionUserStats);

    expect(getUserGameStatistics).toHaveBeenCalledWith('g1', {
      position: undefined,
      sortBy: 'totalCount',
      page: 1,
      limit: 50,
      scope: { gameTypes: ['2', '3'], competitionId: 7 },
    });
  });

  test('gameType을 주면 그 유형만 본다', async () => {
    await run(getCompetitionUserStats, { gameType: '3', position: 'MID', sortBy: 'winRate' });

    expect(getUserGameStatistics).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({
        position: 'MID',
        sortBy: 'winRate',
        scope: { gameTypes: ['3'], competitionId: 7 },
      }),
    );
  });

  test('길드의 대회가 아니면 통계를 조회하지 않고 404로 넘긴다', async () => {
    assertExists.mockRejectedValue(
      new BusinessError('competition not found', 404, {
        type: 'competition-not-found',
        isLoggable: false,
      }),
    );

    const { next, res } = await run(getCompetitionUserStats);

    expect(getUserGameStatistics).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, type: 'competition-not-found' }),
    );
  });
});

describe('대회 챔피언 통계', () => {
  test('200 + 기본 20개 페이지 헤더', async () => {
    const { res } = await run(getCompetitionChampionStats);

    expect(getChampionStatistics).toHaveBeenCalledWith('g1', {
      position: undefined,
      sortBy: 'totalCount',
      page: 1,
      limit: 20,
      scope: { gameTypes: ['2', '3'], competitionId: 7 },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      status: 'success',
      message: 'Competition champion statistics retrieved successfully',
      data: [{ champName: '아리', champNameEng: 'Ahri', totalCount: 2 }],
    });
    expect(res.headers).toMatchObject({ 'X-Limit': '20', 'X-Total-Pages': '1' });
  });

  test('길드의 대회가 아니면 404로 넘긴다', async () => {
    assertExists.mockRejectedValue(
      new BusinessError('competition not found', 404, {
        type: 'competition-not-found',
        isLoggable: false,
      }),
    );

    const { next } = await run(getCompetitionChampionStats);

    expect(getChampionStatistics).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ status: 404, type: 'competition-not-found' }),
    );
  });
});
