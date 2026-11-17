import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express, { NextFunction, Request, Response } from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

const getOverview = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../services/siteStatistics.service.js', () => ({
  siteStatisticsService: { getOverview },
}));

const { default: siteStatisticsRoutes } = await import('../routes/siteStatistics.routes.js');
const { siteOverviewCache } = await import('../controllers/siteStatistics.controller.js');

const overview = {
  clanCount: 3,
  matchCount: 120,
  playerCount: 45,
  recentMatchCount: 20,
  matchCountByType: { normal: 100, competition: 20 },
};

let server: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use('/api', siteStatisticsRoutes);
  // Express는 인자 네 개로 오류 처리 미들웨어를 구분한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ status: 'error' });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/statistics/overview`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  getOverview.mockReset();
  siteOverviewCache.clear();
});

describe('GET /api/statistics/overview', () => {
  test('집계 결과를 data로 반환한다', async () => {
    getOverview.mockResolvedValue(overview);

    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'success',
      message: 'Site overview retrieved successfully',
      data: overview,
    });
  });

  test('같은 갱신 주기 안의 반복 요청은 집계를 다시 실행하지 않는다', async () => {
    getOverview.mockResolvedValue(overview);

    await fetch(url);
    await fetch(url);

    expect(getOverview).toHaveBeenCalledTimes(1);
  });

  test('집계가 실패하면 오류 처리로 넘기고 다음 요청에서 다시 집계한다', async () => {
    getOverview.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(overview);

    expect((await fetch(url)).status).toBe(500);
    expect((await fetch(url)).status).toBe(200);
    expect(getOverview).toHaveBeenCalledTimes(2);
  });
});
