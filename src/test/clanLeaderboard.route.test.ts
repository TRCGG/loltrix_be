import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const getChampionCombinations = jest.fn<AsyncFn>();
const getDuos = jest.fn<AsyncFn>();
const getActivity = jest.fn<AsyncFn>();
const getChampionStatistics = jest.fn<AsyncFn>();
const getUserGameStatistics = jest.fn<AsyncFn>();
const getRisingStars = jest.fn<AsyncFn>();
const getHighlights = jest.fn<AsyncFn>();
const getWinStreaks = jest.fn<AsyncFn>();

jest.unstable_mockModule('../services/clanLeaderboard.service.js', () => ({
  clanLeaderboardService: { getChampionCombinations, getDuos, getActivity },
}));
jest.unstable_mockModule('../services/statistics.service.js', () => ({
  statisticsService: { getChampionStatistics, getUserGameStatistics },
}));
jest.unstable_mockModule('../services/clanLeaderboardMetrics.service.js', () => ({
  clanLeaderboardMetricsService: { getRisingStars, getHighlights, getWinStreaks },
}));
const { default: router } = await import('../routes/statistics.route.js');
const app = express();
app.use('/statistics', router);
const server = createServer(app);
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/statistics/${Buffer.from('guild-1').toString('base64')}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const service of [
    getChampionCombinations,
    getDuos,
    getChampionStatistics,
    getUserGameStatistics,
  ]) {
    service.mockResolvedValue({ result: [], totalCount: 12 });
  }
  getActivity.mockResolvedValue({
    totalMatches: 3,
    totalPlayers: 10,
    dailyMatches: [{ date: '2026-09-01', matchCount: 3 }],
  });
  getRisingStars.mockResolvedValue([]);
  getHighlights.mockResolvedValue({ kills: { value: null, entries: [] } });
  getWinStreaks.mockResolvedValue([]);
});

describe('클랜 리더보드 HTTP 계약', () => {
  test.each([
    { path: '/rising-stars', service: getRisingStars },
    { path: '/highlights', service: getHighlights },
    { path: '/win-streaks', service: getWinStreaks },
  ])('$path는 선택적 시즌만 받고 새 성공 응답을 반환한다', async ({ path, service }) => {
    const response = await fetch(`${baseUrl}${path}?season=2025`);
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith('guild-1', '2025');
    expect(await response.json()).toMatchObject({ status: 'success' });
    expect(response.headers.get('x-limit')).toBeNull();
  });

  test.each(['/rising-stars', '/highlights', '/win-streaks'])(
    '%s는 기간·포지션·페이지·경기유형을 거부한다',
    async (path) => {
      for (const query of ['datePreset=recent30', 'position=TOP', 'page=1', 'gameType=1']) {
        expect((await fetch(`${baseUrl}${path}?${query}`)).status).toBe(400);
      }
      expect(getRisingStars).not.toHaveBeenCalled();
      expect(getHighlights).not.toHaveBeenCalled();
      expect(getWinStreaks).not.toHaveBeenCalled();
    },
  );

  test.each([
    { path: '/users?sortBy=totalCount', service: getUserGameStatistics },
    { path: '/users?sortBy=wilsonScore', service: getUserGameStatistics },
    { path: '/champions?sortBy=totalCount', service: getChampionStatistics },
    { path: '/champions?sortBy=pickRate', service: getChampionStatistics },
    { path: '/champions?sortBy=wilsonScore', service: getChampionStatistics },
    { path: '/champion-combinations?combination=ADCSUP', service: getChampionCombinations },
    { path: '/duos', service: getDuos },
    { path: '/activity', service: getActivity },
  ])('recent30 요청을 서비스에 전달한다: $path', async ({ path, service }) => {
    const response = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}datePreset=recent30`);
    expect(response.status).toBe(200);
    expect(service).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({ datePreset: 'recent30' }),
    );
  });

  test('조합은 기간만 전달하고 기본 TOP 5 페이지 헤더를 반환한다', async () => {
    const response = await fetch(
      `${baseUrl}/champion-combinations?combination=ADCSUP&position=TOP&datePreset=season&season=2026`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-total-count')).toBe('12');
    expect(response.headers.get('x-page')).toBe('1');
    expect(response.headers.get('x-limit')).toBe('5');
    expect(response.headers.get('x-total-pages')).toBe('3');
    expect(getChampionCombinations).toHaveBeenCalledWith('guild-1', {
      combination: 'ADCSUP',
      datePreset: 'season',
      season: '2026',
      fromMonth: undefined,
      toMonth: undefined,
      page: 1,
      limit: 5,
    });
    expect(await response.json()).toMatchObject({ status: 'success', data: [] });
  });

  test('듀오는 포지션을 무시하고 월 범위와 숫자 페이지를 전달한다', async () => {
    const response = await fetch(
      `${baseUrl}/duos?datePreset=range&fromMonth=11&toMonth=2&season=2026&position=MID&page=2&limit=10`,
    );
    expect(response.status).toBe(200);
    expect(getDuos).toHaveBeenCalledWith('guild-1', {
      datePreset: 'range',
      fromMonth: '11',
      toMonth: '2',
      season: '2026',
      page: 2,
      limit: 10,
    });
  });

  test('활동 응답에는 집계 규모와 일별 경기 수가 실린다', async () => {
    const response = await fetch(`${baseUrl}/activity?position=SUP`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        totalMatches: 3,
        totalPlayers: 10,
        dailyMatches: [{ date: '2026-09-01', matchCount: 3 }],
      },
    });
    expect(getActivity).toHaveBeenCalledWith('guild-1', {
      datePreset: undefined,
      fromMonth: undefined,
      toMonth: undefined,
      season: undefined,
    });
  });

  test.each([
    '/champion-combinations',
    '/champion-combinations?combination=unknown',
    '/duos?page=0',
    '/duos?limit=101',
    '/duos?page=9007199254740992',
    '/activity?datePreset=range&fromMonth=1&toMonth=2',
    '/activity?datePreset=range&fromMonth=13&toMonth=2&season=2026',
  ])('잘못된 입력은 DB 조회 전에 400: %s', async (path) => {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(400);
    expect(getChampionCombinations).not.toHaveBeenCalled();
    expect(getDuos).not.toHaveBeenCalled();
    expect(getActivity).not.toHaveBeenCalled();
  });

  test.each(['pickRate', 'wilsonScore'])(
    '새 챔피언 정렬 %s와 ALL을 서비스에 전달한다',
    async (sortBy) => {
      const response = await fetch(`${baseUrl}/champions?sortBy=${sortBy}&position=ALL`);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-limit')).toBe('5');
      expect(getChampionStatistics).toHaveBeenCalledWith(
        'guild-1',
        expect.objectContaining({ sortBy, position: 'ALL', limit: 5, scope: { gameTypes: ['1'] } }),
      );
    },
  );

  test('우수 성적 랭킹은 일반내전으로 조회하며 기본 TOP 5를 반환한다', async () => {
    const response = await fetch(`${baseUrl}/users?sortBy=wilsonScore&position=ALL`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-limit')).toBe('5');
    expect(getUserGameStatistics).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({
        sortBy: 'wilsonScore',
        position: 'ALL',
        limit: 5,
        scope: { gameTypes: ['1'] },
      }),
    );
  });

  test('Wilson 정렬은 대회 경기를 거절한다', async () => {
    for (const path of [
      '/champions?sortBy=pickRate&gameType=2',
      '/users?sortBy=wilsonScore&gameType=2,3',
      '/champions?sortBy=wilsonScore&limit=0',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(400);
    }
    expect(getChampionStatistics).not.toHaveBeenCalled();
    expect(getUserGameStatistics).not.toHaveBeenCalled();
  });

  test('기존 챔피언 조회는 기본 20개와 대회 유형 옵션을 유지한다', async () => {
    const response = await fetch(`${baseUrl}/champions?gameType=2,3&sortBy=winRate`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-limit')).toBe('20');
    expect(getChampionStatistics).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({ sortBy: 'winRate', limit: 20, scope: { gameTypes: ['2', '3'] } }),
    );
  });
});
