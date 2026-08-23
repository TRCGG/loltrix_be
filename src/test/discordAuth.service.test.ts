import { jest, describe, test, expect, afterEach } from '@jest/globals';

type FetchResult = { ok: boolean; json: () => Promise<unknown> };

const fetchWithTimeout = jest.fn<(...args: unknown[]) => Promise<FetchResult>>();

// 소스가 ESM 이라 jest.mock 호이스팅이 동작하지 않는다.
// unstable_mockModule 로 등록한 뒤 대상 모듈을 동적 import 해야 목이 적용된다.
jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: {} }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getNumberConfig: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
    getConfigOrDefault: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
    getListConfig: jest.fn(async () => []),
  },
}));
jest.unstable_mockModule('../utils/fetchWithTimeout.js', () => ({ fetchWithTimeout }));

const { DiscordAuthService } = await import('../services/discordAuth.service.js');
const { SystemError } = await import('../types/error.js');

const service = new DiscordAuthService();

const userResponse = (memberId: string, overrides: Record<string, unknown> = {}): FetchResult => ({
  ok: true,
  json: async () => ({
    id: memberId,
    username: 'gmok',
    global_name: '지목',
    avatar: 'abc123',
    ...overrides,
  }),
});

const tokenResponse = (): FetchResult => ({
  ok: true,
  json: async () => ({
    access_token: 'access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-token',
    scope: 'identify',
  }),
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fetchUser 프로필 캐시', () => {
  test('같은 유저의 두 번째 조회는 Discord를 다시 부르지 않는다', async () => {
    fetchWithTimeout.mockResolvedValue(userResponse('100'));

    const first = await service.fetchUser('access-a', '100');
    const second = await service.fetchUser('access-b', '100');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first).toEqual({
      id: '100',
      username: 'gmok',
      global_name: '지목',
      avatar: 'https://cdn.discordapp.com/avatars/100/abc123.png',
    });
  });

  test('유저가 다르면 각자 조회한다', async () => {
    fetchWithTimeout.mockImplementation(async () => userResponse('110'));

    await service.fetchUser('access', '110');
    await service.fetchUser('access', '111');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  test('동시 요청은 하나의 외부 호출을 공유한다', async () => {
    let release!: (value: FetchResult) => void;
    fetchWithTimeout.mockReturnValue(
      new Promise<FetchResult>((resolve) => {
        release = resolve;
      }),
    );

    const first = service.fetchUser('access', '200');
    const second = service.fetchUser('access', '200');
    release(userResponse('200'));

    expect(await first).toEqual(await second);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  test('실패는 캐시하지 않아 다음 요청이 다시 조회한다', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithTimeout.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

    await expect(service.fetchUser('access', '300')).rejects.toBeInstanceOf(SystemError);

    fetchWithTimeout.mockResolvedValueOnce(userResponse('300'));
    const profile = await service.fetchUser('access', '300');

    expect(profile.id).toBe('300');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});

describe('로그인·로그아웃 시 캐시 무효화', () => {
  test('로그인 콜백이 캐시를 최신 프로필로 채운다', async () => {
    fetchWithTimeout
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(userResponse('400', { global_name: '바뀐이름', avatar: 'newhash' }));
    jest
      .spyOn(
        service as unknown as { handleLoginTransaction: () => Promise<string> },
        'handleLoginTransaction',
      )
      .mockResolvedValue('session-uid');

    await service.handleDiscordCallback('code', 'agent', '127.0.0.1');
    fetchWithTimeout.mockClear();

    const profile = await service.fetchUser('access', '400');

    expect(fetchWithTimeout).not.toHaveBeenCalled();
    expect(profile).toEqual({
      id: '400',
      username: 'gmok',
      global_name: '바뀐이름',
      avatar: 'https://cdn.discordapp.com/avatars/400/newhash.png',
    });
  });

  test('로그아웃은 해당 유저 캐시만 비운다', async () => {
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithTimeout.mockImplementation(async () => userResponse('500'));
    await service.fetchUser('access', '500');
    await service.fetchUser('access', '501');

    jest
      .spyOn(service, 'findAuthSessionByUid')
      .mockResolvedValue({ discordMemberId: '500' } as never);
    jest.spyOn(service, 'findDiscordTokenById').mockResolvedValue(undefined as never);
    jest.spyOn(service, 'deactivateSession').mockResolvedValue(undefined as never);

    await service.revokeAndDeactivateSession('session-uid');
    fetchWithTimeout.mockClear();

    await service.fetchUser('access', '500');
    await service.fetchUser('access', '501');

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    consoleWarn.mockRestore();
  });
});

export {};
