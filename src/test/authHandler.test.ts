import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const findAuthSessionByUid = jest.fn<(uid: string) => Promise<unknown>>();
const getValidAccessToken = jest.fn<(memberId: string) => Promise<unknown>>();

jest.unstable_mockModule('../services/discordAuth.service.js', () => ({
  DiscordAuthService: class {
    findAuthSessionByUid = findAuthSessionByUid;

    getValidAccessToken = getValidAccessToken;
  },
}));

jest.unstable_mockModule('../utils/cookieOptions.js', () => ({
  getClearCookieOptions: jest.fn(async () => ({})),
}));

const { restrictBotToLocalhost, verifyAuth } = await import('../middlewares/authHandler.js');
const { BusinessError } = await import('../types/error.js');

type ReqParts = {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  remoteAddress?: string;
};

const makeReq = ({ headers = {}, cookies = {}, remoteAddress = '127.0.0.1' }: ReqParts) =>
  ({
    headers,
    cookies,
    socket: { remoteAddress },
    ip: '127.0.0.1',
  }) as unknown as Request;

const makeRes = () => ({ clearCookie: jest.fn() }) as unknown as Response;

describe('restrictBotToLocalhost', () => {
  let warn: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('봇 헤더 + 로컬 소켓이면 통과한다', () => {
    const next = jest.fn() as unknown as NextFunction;

    restrictBotToLocalhost(
      makeReq({ headers: { 'x-discord-bot': 'secret' }, remoteAddress: '::1' }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('봇 헤더 + 외부 소켓이면 403으로 막는다', () => {
    const next = jest.fn() as unknown as NextFunction;
    const call = () =>
      restrictBotToLocalhost(
        makeReq({ headers: { 'x-discord-bot': 'secret' }, remoteAddress: '203.0.113.9' }),
        makeRes(),
        next,
      );

    expect(call).toThrow(BusinessError);
    expect(call).toThrow(/203\.0\.113\.9/);
    expect(next).not.toHaveBeenCalled();
  });

  test('403은 error_log에 적재하지 않고 stderr 경고만 남긴다', () => {
    try {
      restrictBotToLocalhost(
        makeReq({ headers: { 'x-discord-bot': 'secret' }, remoteAddress: '203.0.113.9' }),
        makeRes(),
        jest.fn() as unknown as NextFunction,
      );
    } catch (error) {
      expect((error as InstanceType<typeof BusinessError>).status).toBe(403);
      expect((error as InstanceType<typeof BusinessError>).isLoggable).toBe(false);
    }

    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('203.0.113.9');
    expect.assertions(3);
  });

  test('외부에서 세션 쿠키를 붙여도 봇 헤더가 있으면 막힌다', () => {
    const next = jest.fn() as unknown as NextFunction;

    expect(() =>
      restrictBotToLocalhost(
        makeReq({
          headers: { 'x-discord-bot': 'secret' },
          cookies: { session_uid: 'anything' },
          remoteAddress: '203.0.113.9',
        }),
        makeRes(),
        next,
      ),
    ).toThrow(BusinessError);
    expect(next).not.toHaveBeenCalled();
  });

  test('봇 헤더가 없으면 소켓 주소와 무관하게 통과한다', () => {
    const next = jest.fn() as unknown as NextFunction;

    restrictBotToLocalhost(
      makeReq({ cookies: { session_uid: 'abc' }, remoteAddress: '203.0.113.9' }),
      makeRes(),
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('verifyAuth 봇 검증', () => {
  const originalSecret = process.env.DISCORD_BOT_SECRET;

  afterEach(() => {
    process.env.DISCORD_BOT_SECRET = originalSecret;
  });

  test('시크릿이 일치하면 isBot을 세운다', async () => {
    process.env.DISCORD_BOT_SECRET = 'right-secret';
    const req = makeReq({ headers: { 'x-discord-bot': 'right-secret' } });
    const next = jest.fn() as unknown as NextFunction;

    await verifyAuth(req, makeRes(), next);

    expect((req as { isBot?: boolean }).isBot).toBe(true);
    expect(next).toHaveBeenCalledWith();
  });

  test('시크릿이 틀리면 403을 넘긴다', async () => {
    process.env.DISCORD_BOT_SECRET = 'right-secret';
    const next = jest.fn() as unknown as NextFunction;

    await verifyAuth(makeReq({ headers: { 'x-discord-bot': 'wrong' } }), makeRes(), next);

    const error = (next as unknown as jest.Mock).mock.calls[0][0] as InstanceType<
      typeof BusinessError
    >;
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.status).toBe(403);
  });

  test('환경변수가 없으면 어떤 헤더 값도 통과시키지 않는다', async () => {
    delete process.env.DISCORD_BOT_SECRET;
    const req = makeReq({ headers: { 'x-discord-bot': 'undefined' } });
    const next = jest.fn() as unknown as NextFunction;

    await verifyAuth(req, makeRes(), next);

    const error = (next as unknown as jest.Mock).mock.calls[0][0] as InstanceType<
      typeof BusinessError
    >;
    expect(error.status).toBe(403);
    expect((req as { isBot?: boolean }).isBot).toBeUndefined();
  });
});

describe('verifyAuth 세션 쿠키 형식 검증', () => {
  beforeEach(() => {
    findAuthSessionByUid.mockReset();
    getValidAccessToken.mockReset();
  });

  test('형식이 어긋난 쿠키는 DB 조회 없이 401로 막고 쿠키를 지운다', async () => {
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await verifyAuth(makeReq({ cookies: { session_uid: 'abc' } }), res, next);

    const error = (next as unknown as jest.Mock).mock.calls[0][0] as InstanceType<
      typeof BusinessError
    >;
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.status).toBe(401);
    expect(res.clearCookie).toHaveBeenCalledWith('session_uid', expect.anything());
    expect(findAuthSessionByUid).not.toHaveBeenCalled();
  });

  test('uuid 형식 쿠키는 그대로 세션 조회에 넘어간다', async () => {
    const sessionUid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    findAuthSessionByUid.mockResolvedValue({ discordMemberId: '1234567890' });
    getValidAccessToken.mockResolvedValue('access-token');

    const req = makeReq({ cookies: { session_uid: sessionUid } });
    const next = jest.fn() as unknown as NextFunction;

    await verifyAuth(req, makeRes(), next);

    expect(findAuthSessionByUid).toHaveBeenCalledWith(sessionUid);
    expect(next).toHaveBeenCalledWith();
    expect((req as { discordMemberId?: string }).discordMemberId).toBe('1234567890');
  });
});

export {};
