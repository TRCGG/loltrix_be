import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';

type TerminalRequest = Request & { params: Record<string, string> };
const terminalHandler = jest.fn((req: TerminalRequest, res: Response) => {
  res.end(JSON.stringify(req.params));
});
const isPublicGuild = jest.fn<(guildId: string) => Promise<boolean>>();

jest.unstable_mockModule('../services/guild.service.js', () => ({
  guildService: { isPublicGuild },
}));

jest.unstable_mockModule('../routes/guildMember.routes.js', () => ({
  default: Router(),
  searchGuildMembersReadHandlers: [terminalHandler],
}));
jest.unstable_mockModule('../routes/matchParticipant.routes.js', () => ({
  default: Router(),
  recentGamesReadHandlers: [terminalHandler],
  matchDashboardReadHandlers: [terminalHandler],
  mostPicksReadHandlers: [terminalHandler],
  gameDetailReadHandlers: [terminalHandler],
}));
jest.unstable_mockModule('../routes/statistics.route.js', () => ({
  default: Router(),
  userStatisticsReadHandlers: [terminalHandler],
  championStatisticsReadHandlers: [terminalHandler],
}));
jest.unstable_mockModule('../routes/h2h.routes.js', () => ({
  default: Router(),
  frequentOpponentsReadHandlers: [terminalHandler],
  h2hDetailReadHandlers: [terminalHandler],
}));

const {
  default: publicGuildReadRouter,
  decodePublicGuildId,
  requirePublicGuild,
} = await import('../routes/publicGuildRead.routes.js');

const GUILD_ID = '987654321098765432';
const ENCODED_GUILD_ID = Buffer.from(GUILD_ID).toString('base64');

type RunResult = {
  fallback: boolean;
  headers: Record<string, string>;
  body?: string;
};

const runRouter = (method: string, url: string, headers: Record<string, string> = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    const responseHeaders: Record<string, string> = {};
    let finished = false;
    const finish = (result: RunResult) => {
      if (!finished) {
        finished = true;
        resolve(result);
      }
    };
    const req = { method, url, originalUrl: url, headers } as Request;
    const res = {
      setHeader(name: string, value: string) {
        responseHeaders[name] = String(value);
      },
      getHeader(name: string) {
        return responseHeaders[name];
      },
      end(body?: string) {
        finish({ fallback: false, headers: responseHeaders, body });
      },
    } as unknown as Response;

    const router = publicGuildReadRouter as unknown as {
      handle: (request: Request, response: Response, next: (error?: unknown) => void) => void;
    };
    router.handle(req, res, (error?: unknown) => {
      if (error) reject(error);
      else finish({ fallback: true, headers: responseHeaders });
    });
  });

beforeEach(() => {
  terminalHandler.mockClear();
  isPublicGuild.mockReset().mockResolvedValue(true);
});

describe('공개 길드 조회 라우터 경계', () => {
  const approvedPaths = [
    `/guildMember/${ENCODED_GUILD_ID}/HideOnBush`,
    `/matches/${ENCODED_GUILD_ID}/HideOnBush/games`,
    `/matches/${ENCODED_GUILD_ID}/HideOnBush/dashboard`,
    `/matches/${ENCODED_GUILD_ID}/HideOnBush/most-picks`,
    `/matches/${ENCODED_GUILD_ID}/games/KR_1234`,
    `/statistics/${ENCODED_GUILD_ID}/users`,
    `/statistics/${ENCODED_GUILD_ID}/champions`,
    `/h2h/${ENCODED_GUILD_ID}`,
    `/h2h/${ENCODED_GUILD_ID}/frequent`,
  ];

  test.each(approvedPaths)('공개 길드는 세션 없이 승인된 GET을 처리한다: %s', async (path) => {
    const result = await runRouter('GET', path);

    expect(result.fallback).toBe(false);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(isPublicGuild).toHaveBeenCalledWith(GUILD_ID);
  });

  test('잘못된 세션 쿠키나 멤버 식별정보가 없어도 공개 조회 결과는 같다', async () => {
    const path = `/statistics/${ENCODED_GUILD_ID}/users`;

    const invalidCookie = await runRouter('GET', path, { cookie: 'session_uid=not-a-uuid' });
    const noMembership = await runRouter('GET', path);

    expect(invalidCookie.fallback).toBe(false);
    expect(noMembership.fallback).toBe(false);
    expect(terminalHandler).toHaveBeenCalledTimes(2);
  });

  test('HEAD만 GET과 함께 허용하고 다른 메서드는 인증 라우터로 넘긴다', async () => {
    const path = `/h2h/${ENCODED_GUILD_ID}`;

    expect((await runRouter('HEAD', path)).fallback).toBe(false);
    expect((await runRouter('POST', path)).fallback).toBe(true);
    expect((await runRouter('PUT', `/guilds/${GUILD_ID}`)).fallback).toBe(true);
    expect(isPublicGuild).toHaveBeenCalledTimes(1);
  });

  test('비공개·없는·삭제된 길드는 매 요청마다 확인하고 인증 라우터로 넘긴다', async () => {
    isPublicGuild.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(false);
    const path = `/h2h/${ENCODED_GUILD_ID}`;

    expect((await runRouter('GET', path)).fallback).toBe(false);
    expect((await runRouter('GET', path)).fallback).toBe(true);
    expect((await runRouter('GET', path)).fallback).toBe(true);
    expect(isPublicGuild).toHaveBeenCalledTimes(3);
  });

  test('공개 여부 조회 실패는 인증 라우터로 닫힌다', async () => {
    isPublicGuild.mockRejectedValue(new Error('db unavailable'));

    const result = await runRouter('GET', `/h2h/${ENCODED_GUILD_ID}`);

    expect(result.fallback).toBe(true);
    expect(terminalHandler).not.toHaveBeenCalled();
  });

  test.each(['members', 'MEMBERS', '%6dembers', 'sub-accounts', 'discord-members', 'audit-logs'])(
    '멤버 관리 경로는 검색 와일드카드로 공개되지 않는다: %s',
    async (reservedPath) => {
      const result = await runRouter('GET', `/guildMember/${ENCODED_GUILD_ID}/${reservedPath}`);

      expect(result.fallback).toBe(true);
      expect(isPublicGuild).not.toHaveBeenCalled();
    },
  );

  test('허용하지 않은 조회와 쓰기는 공개 길드여도 인증 라우터로 넘긴다', async () => {
    const paths = [
      `/competitions/${ENCODED_GUILD_ID}`,
      `/guildMember/${ENCODED_GUILD_ID}/discord-members/123/role`,
      `/replays?guildId=${ENCODED_GUILD_ID}`,
    ];

    const results = await Promise.all(paths.map((path) => runRouter('GET', path)));
    expect(results.every((result) => result.fallback)).toBe(true);
    expect((await runRouter('DELETE', `/matches/${ENCODED_GUILD_ID}/games/KR_1`)).fallback).toBe(
      true,
    );
    expect(isPublicGuild).not.toHaveBeenCalled();
  });

  test('경로 guildId만 공개 판정에 쓰고 query guildId는 덮어쓰지 않는다', async () => {
    const privateQueryGuild = Buffer.from('private-guild').toString('base64');
    const result = await runRouter(
      'GET',
      `/matches/${ENCODED_GUILD_ID}/games/KR_1?guildId=${privateQueryGuild}`,
    );

    expect(result.fallback).toBe(false);
    expect(isPublicGuild).toHaveBeenCalledWith(GUILD_ID);
  });

  test('봇 헤더가 있으면 공개 판정 없이 기존 봇 인증으로 넘긴다', async () => {
    const result = await runRouter('GET', `/h2h/${ENCODED_GUILD_ID}`, {
      'x-discord-bot': 'wrong-secret',
    });

    expect(result.fallback).toBe(true);
    expect(isPublicGuild).not.toHaveBeenCalled();
  });

  test.each(['***', 'A', 'YWJj===', Buffer.from([0xff]).toString('base64')])(
    '엄격히 디코딩할 수 없는 guildId는 공개하지 않는다: %s',
    async (malformed) => {
      expect((await runRouter('GET', `/h2h/${encodeURIComponent(malformed)}`)).fallback).toBe(true);
    },
  );
});

describe('공개 판정은 요청을 변경하지 않는다', () => {
  test('비공개 fallback에서 params와 query가 그대로 남는다', async () => {
    isPublicGuild.mockResolvedValue(false);
    const params = { guildId: ENCODED_GUILD_ID };
    const query = { guildId: Buffer.from('other').toString('base64'), page: '2' };
    const req = { params, query, headers: {} } as unknown as Request<{ guildId: string }>;
    const next = jest.fn() as unknown as NextFunction;

    await requirePublicGuild(req, { setHeader: jest.fn() } as unknown as Response, next);

    expect(next).toHaveBeenCalledWith('router');
    expect(req.params).toBe(params);
    expect(req.query).toBe(query);
  });

  test('정상 Base64만 UTF-8 guildId로 해석한다', () => {
    expect(decodePublicGuildId(ENCODED_GUILD_ID)).toBe(GUILD_ID);
    expect(decodePublicGuildId('A')).toBeNull();
    expect(decodePublicGuildId('YWJj===')).toBeNull();
  });
});
