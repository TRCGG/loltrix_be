import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import type { Request } from 'express';

// error_log INSERT 가 실패하는 상황을 만든다. 컨트롤러 catch 안의 logErrorFromRequest 가
// reject 하면 감싸는 try 가 없어 unhandledRejection 이 되고 응답이 나가지 못한다.
type AsyncFn = (...args: any[]) => Promise<any>;

const values = jest.fn<AsyncFn>();
const insert = jest.fn<(table: unknown) => { values: typeof values }>(() => ({ values }));

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: { insert },
}));

const { getGmokGuilds } = await import('../controllers/discordAuth.controller.js');

// 컨트롤러가 res.status(...).json(...) 으로 체이닝하므로 status 는 json 을 가진 객체를 돌려준다
const makeRes = () => {
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { status, json };
};

// accessToken 미주입 → 컨트롤러가 SystemError 를 던져 catch 경로로 들어간다
const makeReq = () =>
  ({
    method: 'GET',
    url: '/api/auth/guilds',
    originalUrl: '/api/auth/guilds',
    get: jest.fn(),
    body: {},
    query: {},
    params: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  }) as unknown as Request;

describe('getGmokGuilds - 에러 로깅 실패 시 응답 보장', () => {
  beforeEach(() => {
    values.mockRejectedValue(
      Object.assign(new Error('Failed query: insert into error_log ...'), {
        cause: { code: '42P01' },
      }),
    );
  });

  test('error_log 기록이 실패해도 500 응답을 내보낸다', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = makeRes();

    await getGmokGuilds(makeReq() as any, res as any);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        message: 'Internal server error discordAuth getGmokGuilds',
        data: null,
      }),
    );

    consoleError.mockRestore();
  });

  test('로깅 실패 사실이 stderr에 남는다', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await getGmokGuilds(makeReq() as any, makeRes() as any);

    const logged = consoleError.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('[error_log FALLBACK]');
    expect(logged).toContain('42P01');

    consoleError.mockRestore();
  });
});

export {};
