import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import cookieParser from 'cookie-parser';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';

const findAllGuilds =
  jest.fn<(...args: unknown[]) => Promise<{ result: unknown[]; totalCount: number }>>();
const isPublicGuild = jest.fn<(guildId: string) => Promise<boolean>>();
const updateGuild =
  jest.fn<(guildId: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const getUserGameStatistics =
  jest.fn<
    (
      guildId: string,
      options: Record<string, unknown>,
    ) => Promise<{ result: unknown[]; totalCount: number }>
  >();
const findAuthSessionByUid =
  jest.fn<(sessionUid: string) => Promise<{ discordMemberId: string } | undefined>>();
const getValidAccessToken = jest.fn<(memberId: string) => Promise<string>>();
const getActiveRoles = jest.fn<(_memberId: string) => Promise<Array<{ role: string }>>>();

const unexpectedDb = new Proxy(
  {},
  {
    get: (_target, property) => () => {
      throw new Error(`Unexpected DB access: ${String(property)}`);
    },
  },
);

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: unexpectedDb,
  getClient: jest.fn(),
  getPool: jest.fn(),
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({
  GuildService: function GuildServiceMock() {
    return { isPublicGuild, updateGuild };
  },
  guildService: {
    isPublicGuild,
    updateGuild,
    findGuildById: jest.fn(),
    findAllGuilds,
    insertGuild: jest.fn(),
    softDeleteGuild: jest.fn(),
    updateAllowAllUploads: jest.fn(),
  },
}));
jest.unstable_mockModule('../services/statistics.service.js', () => ({
  statisticsService: {
    getUserGameStatistics,
    getChampionStatistics: jest.fn(async () => ({ result: [], totalCount: 0 })),
  },
}));
jest.unstable_mockModule('../services/discordAuth.service.js', () => ({
  DiscordAuthService: class {
    findAuthSessionByUid = findAuthSessionByUid;

    getValidAccessToken = getValidAccessToken;
  },
}));
jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: {
    getActiveRoles,
    getActiveRolesByGuild: jest.fn(async () => []),
  },
}));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getConfigOrDefault: jest.fn(async (_key: string, fallback: unknown) => fallback),
    getNumberConfig: jest.fn(async (_key: string, fallback: unknown) => fallback),
  },
}));
jest.unstable_mockModule('../services/errorLog.service.js', () => ({
  logErrorFromRequest: jest.fn(async () => null),
}));

const { default: apiRoutes } = await import('../routes/index.js');
const { errorHandler } = await import('../middlewares/errorHandler.js');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api', apiRoutes);
app.use(errorHandler);

const GUILD_ID = '987654321098765432';
const ENCODED_GUILD_ID = Buffer.from(GUILD_ID).toString('base64');
const VALID_SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ORIGINAL_BOT_SECRET = process.env.DISCORD_BOT_SECRET;

type InjectOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

type InjectResponse = {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json: unknown;
};

const inject = (url: string, options: InjectOptions = {}) =>
  new Promise<InjectResponse>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const socket = new Socket();
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(socket);
    req.method = options.method ?? 'GET';
    req.url = url;
    req.headers = {
      ...(payload
        ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
          }
        : {}),
      ...options.headers,
    };

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      const body = Buffer.concat(chunks).toString('utf8');
      let json: unknown;
      try {
        json = body ? JSON.parse(body) : undefined;
      } catch {
        json = undefined;
      }
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body,
        json,
      });
    };
    res.write = ((chunk: unknown) => {
      if (chunk !== undefined)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    }) as typeof res.write;
    res.end = ((chunk?: unknown) => {
      if (chunk !== undefined)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      complete();
      return res;
    }) as typeof res.end;
    res.on('error', reject);

    app(req, res);
    process.nextTick(() => {
      if (payload) req.push(payload);
      req.push(null);
    });
  });

beforeEach(() => {
  findAllGuilds.mockReset().mockResolvedValue({
    result: [
      { id: GUILD_ID, isPublic: true },
      { id: 'private-guild', isPublic: false },
    ],
    totalCount: 12,
  });
  isPublicGuild.mockReset().mockResolvedValue(true);
  updateGuild.mockReset().mockImplementation(async (id, data) => ({ id, ...data }));
  getUserGameStatistics.mockReset().mockResolvedValue({ result: [], totalCount: 0 });
  findAuthSessionByUid.mockReset().mockResolvedValue({ discordMemberId: 'member-1' });
  getValidAccessToken.mockReset().mockResolvedValue('access-token');
  getActiveRoles.mockReset().mockResolvedValue([{ role: 'userNormal' }]);
});

afterEach(() => {
  if (ORIGINAL_BOT_SECRET === undefined) delete process.env.DISCORD_BOT_SECRET;
  else process.env.DISCORD_BOT_SECRET = ORIGINAL_BOT_SECRET;
});

describe('Session-free guild list', () => {
  test.each(['/api/guilds', '/api/guilds/'])(
    '%s allows anonymous and invalid sessions',
    async (url) => {
      for (const headers of [
        {},
        { cookie: 'session_uid=not-a-uuid' },
        { cookie: `session_uid=${VALID_SESSION}` },
      ] as Record<string, string>[]) {
        const response = await inject(url, { headers });
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['x-total-count']).toBe('12');
        expect(response.headers['x-page']).toBe('1');
        expect(response.headers['x-limit']).toBe('10');
        expect(response.headers['x-total-pages']).toBe('2');
        expect(response.json).toEqual({
          status: 'success',
          message: 'Guilds retrieved successfully',
          data: [
            { id: GUILD_ID, isPublic: true },
            { id: 'private-guild', isPublic: false },
          ],
        });
      }
      expect(findAllGuilds).toHaveBeenCalledWith({
        page: undefined,
        limit: undefined,
        search: undefined,
      });
      expect(findAuthSessionByUid).not.toHaveBeenCalled();
      expect(getValidAccessToken).not.toHaveBeenCalled();
      expect(isPublicGuild).not.toHaveBeenCalled();
    },
  );
  test('search and pagination ignore undeclared isPublic query', async () => {
    const response = await inject('/api/guilds/?page=2&limit=3&search=Public&isPublic=false');
    expect(response.status).toBe(200);
    expect(response.headers['x-total-pages']).toBe('4');
    expect(findAllGuilds).toHaveBeenCalledWith({ page: 2, limit: 3, search: 'Public' });
  });
  test.each([
    'page=0',
    'page=invalid',
    'page=9007199254740992',
    'limit=0',
    'limit=101',
    'limit=1.5',
    'search=' + 'x'.repeat(129),
  ])('rejects invalid query %s', async (query) => {
    expect((await inject(`/api/guilds/?${query}`)).status).toBe(400);
    expect(findAllGuilds).not.toHaveBeenCalled();
    expect(findAuthSessionByUid).not.toHaveBeenCalled();
  });
  test.each([
    { method: 'GET', path: `/api/guilds/${GUILD_ID}` },
    { method: 'POST', path: '/api/guilds/' },
    { method: 'PUT', path: `/api/guilds/${GUILD_ID}` },
    { method: 'DELETE', path: `/api/guilds/${GUILD_ID}` },
    { method: 'PATCH', path: `/api/guilds/${ENCODED_GUILD_ID}/allow-all-uploads` },
  ])('$method $path remains protected', async ({ method, path }) => {
    expect((await inject(path, { method })).status).toBe(401);
    expect(findAllGuilds).not.toHaveBeenCalled();
  });
  test('invalid bot secret uses existing authentication', async () => {
    process.env.DISCORD_BOT_SECRET = 'right-secret';
    expect(
      (await inject('/api/guilds/', { headers: { 'x-discord-bot': 'wrong-secret' } })).status,
    ).toBe(403);
    expect(findAllGuilds).not.toHaveBeenCalled();
  });
});

describe('실제 API 라우터의 공개 길드 인증 경계', () => {
  const statisticsUrl = `/api/statistics/${ENCODED_GUILD_ID}/users?page=2&limit=5`;

  test('공개 통계는 익명 요청을 처리하고 decode와 숫자 transform 결과를 한 번 전달한다', async () => {
    const response = await inject(statisticsUrl);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(isPublicGuild).toHaveBeenCalledTimes(1);
    expect(isPublicGuild).toHaveBeenCalledWith(GUILD_ID);
    expect(getUserGameStatistics).toHaveBeenCalledTimes(1);
    expect(getUserGameStatistics).toHaveBeenCalledWith(
      GUILD_ID,
      expect.objectContaining({ page: 2, limit: 5 }),
    );
    expect(findAuthSessionByUid).not.toHaveBeenCalled();
  });

  test('비공개 길드의 익명 요청은 기존 인증에서 401이다', async () => {
    isPublicGuild.mockResolvedValue(false);

    const response = await inject(statisticsUrl);

    expect(response.status).toBe(401);
    expect(getUserGameStatistics).not.toHaveBeenCalled();
  });

  test('비공개 길드도 유효 세션이면 기존 라우트에서 guildId를 한 번 decode해 조회한다', async () => {
    isPublicGuild.mockResolvedValue(false);

    const response = await inject(statisticsUrl, {
      headers: { cookie: `session_uid=${VALID_SESSION}` },
    });

    expect(response.status).toBe(200);
    expect(findAuthSessionByUid).toHaveBeenCalledWith(VALID_SESSION);
    expect(getUserGameStatistics).toHaveBeenCalledWith(
      GUILD_ID,
      expect.objectContaining({ page: 2, limit: 5 }),
    );
  });

  test('공개·비공개 통계 조회는 같은 schema로 잘못된 query를 동일하게 거부한다', async () => {
    const invalidUrl = `/api/statistics/${ENCODED_GUILD_ID}/users?page=invalid`;
    const publicResponse = await inject(invalidUrl);

    isPublicGuild.mockResolvedValue(false);
    const privateResponse = await inject(invalidUrl, {
      headers: { cookie: `session_uid=${VALID_SESSION}` },
    });

    expect(publicResponse.status).toBe(400);
    expect(privateResponse.status).toBe(400);
    expect(publicResponse.json).toEqual(privateResponse.json);
    expect(getUserGameStatistics).not.toHaveBeenCalled();
  });

  test('공개 설정을 끄면 다음 익명 요청부터 즉시 401이다', async () => {
    isPublicGuild.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await inject(statisticsUrl)).status).toBe(200);
    expect((await inject(statisticsUrl)).status).toBe(401);
    expect(isPublicGuild).toHaveBeenCalledTimes(2);
  });

  test('관리 GET과 경기 DELETE는 공개 길드에서도 인증이 필요하다', async () => {
    const management = await inject(`/api/guildMember/${ENCODED_GUILD_ID}/members`);
    const deletion = await inject(`/api/matches/${ENCODED_GUILD_ID}/games/KR_1`, {
      method: 'DELETE',
    });

    expect(management.status).toBe(401);
    expect(deletion.status).toBe(401);
    expect(isPublicGuild).not.toHaveBeenCalled();
  });

  test('로컬의 잘못된 봇 시크릿은 공개 길드여도 기존 인증에서 403이다', async () => {
    process.env.DISCORD_BOT_SECRET = 'right-secret';

    const response = await inject(statisticsUrl, {
      headers: { 'x-discord-bot': 'wrong-secret' },
    });

    expect(response.status).toBe(403);
    expect(isPublicGuild).not.toHaveBeenCalled();
    expect(getUserGameStatistics).not.toHaveBeenCalled();
  });
});

describe('실제 길드 PUT 공개 설정 권한', () => {
  const guildUrl = `/api/guilds/${GUILD_ID}`;

  test('일반 로그인 사용자는 isPublic을 바꿀 수 없다', async () => {
    const response = await inject(guildUrl, {
      method: 'PUT',
      headers: { cookie: `session_uid=${VALID_SESSION}` },
      body: { isPublic: true },
    });

    expect(response.status).toBe(403);
    expect(updateGuild).not.toHaveBeenCalled();
  });

  test.each([true, false])('adminNormal은 isPublic=%s를 설정할 수 있다', async (isPublic) => {
    getActiveRoles.mockResolvedValue([{ role: 'adminNormal' }]);

    const response = await inject(guildUrl, {
      method: 'PUT',
      headers: { cookie: `session_uid=${VALID_SESSION}` },
      body: { isPublic },
    });

    expect(response.status).toBe(200);
    expect(updateGuild).toHaveBeenCalledWith(GUILD_ID, { isPublic });
  });
});
