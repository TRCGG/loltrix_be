import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express, { NextFunction, Request, Response } from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

const issueCodes = jest.fn<(params: Record<string, unknown>) => Promise<unknown[]>>();
const listCodes =
  jest.fn<(guildId: string, opts: { status?: string; limit: number }) => Promise<unknown[]>>();
const getNextCode = jest.fn<(guildId: string) => Promise<unknown>>();
const roleCheckedGuildIds: string[] = [];
const roleConfigs: unknown[][] = [];

jest.unstable_mockModule('../services/tournament.service.js', () => ({
  tournamentService: { issueCodes, listCodes, getNextCode },
}));
jest.unstable_mockModule('../middlewares/requireRole.js', () => ({
  requireGuildRole: (...config: unknown[]) => {
    roleConfigs.push(config);
    return (req: Request, _res: Response, next: NextFunction) => {
      roleCheckedGuildIds.push(req.params.guildId);
      next();
    };
  },
}));

const { default: router, publicTournamentRoutes } = await import('../routes/tournament.routes.js');

const RAW_GUILD = '987654321098765432';
const ENCODED_GUILD = Buffer.from(RAW_GUILD).toString('base64');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tournament', publicTournamentRoutes);
  app.use('/api/tournament', router);
  // Express는 인자 네 개로 오류 처리 미들웨어를 구분한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status ?? 500;
    res.status(status).json({ message: String(error) });
  });
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tournament`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  issueCodes.mockReset().mockResolvedValue([]);
  listCodes.mockReset().mockResolvedValue([]);
  getNextCode.mockReset().mockResolvedValue(null);
  roleCheckedGuildIds.length = 0;
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('길드 역할 검사는 목록의 userNormal 하나뿐 — 발급은 심사 동안 공개', () => {
  expect(roleConfigs).toEqual([['userNormal', { from: 'params', key: 'guildId' }]]);
});

test('발급만 공개 라우터에 있고 목록·다음 코드는 세션 검증 아래 라우터에 남는다', () => {
  const routesOf = (r: typeof router) =>
    r.stack.flatMap((layer) =>
      layer.route
        ? Object.keys((layer.route as unknown as { methods: Record<string, boolean> }).methods).map(
            (method) => `${method.toUpperCase()} ${layer.route?.path}`,
          )
        : [],
    );

  expect(routesOf(publicTournamentRoutes)).toEqual(['POST /:guildId/codes']);
  expect(routesOf(router)).toEqual(['GET /:guildId/codes', 'GET /:guildId/next-code']);
});

describe('POST /:guildId/codes', () => {
  test.each([
    ['원본 guildId', RAW_GUILD],
    ['Base64가 아닌 값', '!!!'],
    ['디코딩하면 숫자가 아닌 값', Buffer.from('guild-1').toString('base64')],
  ])('%s는 발급하지 않고 400', async (_label, guildId) => {
    const response = await post(`/${encodeURIComponent(guildId)}/codes`, { count: 1 });

    expect(response.status).toBe(400);
    expect(issueCodes).not.toHaveBeenCalled();
  });

  test('Base64 guildId를 디코딩해 권한 검사 없이 발급에 넘긴다', async () => {
    const response = await post(`/${ENCODED_GUILD}/codes`, {
      count: 3,
      spectatorType: 'LOBBYONLY',
    });

    expect(response.status).toBe(201);
    expect(roleCheckedGuildIds).toEqual([]);
    expect(issueCodes).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: RAW_GUILD, count: 3, spectatorType: 'LOBBYONLY' }),
    );
  });

  test.each(['ALL', 'LOBBYONLY', 'NONE'])('관전 설정 %s를 받는다', async (spectatorType) => {
    const response = await post(`/${ENCODED_GUILD}/codes`, { count: 1, spectatorType });

    expect(response.status).toBe(201);
    expect(issueCodes).toHaveBeenCalledWith(expect.objectContaining({ spectatorType }));
  });

  test('관전 설정을 생략하면 서비스 기본값에 맡긴다', async () => {
    const response = await post(`/${ENCODED_GUILD}/codes`, { count: 1 });

    expect(response.status).toBe(201);
    expect(issueCodes).toHaveBeenCalledWith(expect.objectContaining({ spectatorType: undefined }));
  });

  test('허용하지 않는 관전 설정은 400', async () => {
    const response = await post(`/${ENCODED_GUILD}/codes`, { count: 1, spectatorType: 'PUBLIC' });

    expect(response.status).toBe(400);
    expect(issueCodes).not.toHaveBeenCalled();
  });
});

describe('GET /:guildId/codes', () => {
  test('status·limit을 넘기고 디코딩된 guildId로 권한을 확인한다', async () => {
    const response = await fetch(`${baseUrl}/${ENCODED_GUILD}/codes?status=PENDING&limit=10`);

    expect(response.status).toBe(200);
    expect(roleCheckedGuildIds).toEqual([RAW_GUILD]);
    expect(listCodes).toHaveBeenCalledWith(RAW_GUILD, { status: 'PENDING', limit: 10 });
  });

  test('limit 생략 시 50', async () => {
    const response = await fetch(`${baseUrl}/${ENCODED_GUILD}/codes`);

    expect(response.status).toBe(200);
    expect(listCodes).toHaveBeenCalledWith(RAW_GUILD, { status: undefined, limit: 50 });
  });

  test.each(['0', '101'])('limit %s는 400', async (limit) => {
    const response = await fetch(`${baseUrl}/${ENCODED_GUILD}/codes?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(listCodes).not.toHaveBeenCalled();
  });

  test('알 수 없는 status는 400', async () => {
    const response = await fetch(`${baseUrl}/${ENCODED_GUILD}/codes?status=USED`);

    expect(response.status).toBe(400);
  });
});

describe('GET /:guildId/next-code', () => {
  test('디코딩된 guildId로 조회하고 없으면 404 — 권한 검사는 거치지 않는다', async () => {
    const response = await fetch(`${baseUrl}/${ENCODED_GUILD}/next-code`);

    expect(response.status).toBe(404);
    expect(getNextCode).toHaveBeenCalledWith(RAW_GUILD);
    expect(roleCheckedGuildIds).toEqual([]);
  });
});
