import { jest, describe, test, expect, beforeEach } from '@jest/globals';

type FetchResult = { ok: boolean; status?: number; json: () => Promise<unknown> };
type Guild = { id: string; permissions: string };

const fetchWithTimeout =
  jest.fn<(url: string, init?: unknown, timeout?: number) => Promise<FetchResult>>();
const findAllGuilds = jest.fn(async () => ({ result: [{ id: 'gmok-1' }] }));
const freshNicknames = async () =>
  new Map([['gmok-1', { nickname: '지목', updateDate: new Date() }]]);
const findNicknames =
  jest.fn<() => Promise<Map<string, { nickname: string; updateDate: Date }>>>(freshNicknames);

jest.unstable_mockModule('../utils/fetchWithTimeout.js', () => ({ fetchWithTimeout }));
jest.unstable_mockModule('../services/guild.service.js', () => ({
  GuildService: class {
    findAllGuilds = findAllGuilds;
  },
}));
jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: {},
}));
jest.unstable_mockModule('../services/discordGuildNickname.service.js', () => ({
  discordGuildNicknameService: { findNicknames, upsertGuildNicknames: jest.fn(async () => {}) },
}));

const { discordGuildAccessService } = await import('../services/discordGuildAccess.service.js');
const { DISCORD_TOKEN_REJECTED } = await import('../types/discordAuth.js');

const MANAGE_GUILD = '32';
const ADMINISTRATOR = '8';
const SEND_MESSAGES = '2048';

const respondGuilds = (guilds: Guild[]) =>
  fetchWithTimeout.mockResolvedValue({ ok: true, json: async () => guilds });

const userGuildCalls = () =>
  fetchWithTimeout.mock.calls.filter(([url]) => url.endsWith('/users/@me/guilds')).length;

// 캐시가 모듈 전역이라 테스트마다 다른 멤버를 쓴다.
let seq = 0;
const nextMember = () => {
  seq += 1;
  return `member-${seq}`;
};

beforeEach(() => {
  fetchWithTimeout.mockReset();
  findNicknames.mockImplementation(freshNicknames);
});

describe('isDiscordGuildManagerNow', () => {
  test.each([
    ['서버 관리하기', MANAGE_GUILD, true],
    ['관리자', ADMINISTRATOR, true],
    ['관리 권한 없음', SEND_MESSAGES, false],
  ])('%s → %s', async (_label, permissions, expected) => {
    respondGuilds([{ id: 'gmok-1', permissions }]);
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(nextMember(), 'token', 'gmok-1'),
    ).resolves.toBe(expected);
  });

  test('길드에 없으면(강퇴·탈퇴) false', async () => {
    respondGuilds([{ id: 'other', permissions: MANAGE_GUILD }]);
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(nextMember(), 'token', 'gmok-1'),
    ).resolves.toBe(false);
  });

  test('60초 안의 재확인은 Discord를 다시 부르지 않는다', async () => {
    const member = nextMember();
    respondGuilds([{ id: 'gmok-1', permissions: MANAGE_GUILD }]);
    await discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1');
    await discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1');
    expect(userGuildCalls()).toBe(1);
  });

  test('길드 목록 조회가 채운 캐시를 그대로 쓴다', async () => {
    const member = nextMember();
    respondGuilds([{ id: 'gmok-1', permissions: MANAGE_GUILD }]);
    await discordGuildAccessService.findJoinedGmokGuilds('token', member);
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1'),
    ).resolves.toBe(true);
    expect(userGuildCalls()).toBe(1);
  });

  test('길드 목록 캐시에 없는 길드는 Discord로 다시 확인한다', async () => {
    const member = nextMember();
    respondGuilds([{ id: 'gmok-1', permissions: SEND_MESSAGES }]);
    await discordGuildAccessService.findJoinedGmokGuilds('token', member);

    respondGuilds([
      { id: 'gmok-1', permissions: SEND_MESSAGES },
      { id: 'new-guild', permissions: MANAGE_GUILD },
    ]);
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'new-guild'),
    ).resolves.toBe(true);
    expect(userGuildCalls()).toBe(2);
  });

  test('재검증용 조회는 짧은 timeout을 쓴다', async () => {
    respondGuilds([{ id: 'gmok-1', permissions: MANAGE_GUILD }]);
    await discordGuildAccessService.isDiscordGuildManagerNow(nextMember(), 'token', 'gmok-1');
    expect(fetchWithTimeout).toHaveBeenCalledWith(
      expect.stringMatching(/\/users\/@me\/guilds$/),
      expect.anything(),
      3000,
    );
  });

  test('별명 조회 실패로 길드 목록 캐시가 비워져도 60초 안엔 다시 부르지 않는다', async () => {
    const member = nextMember();
    findNicknames.mockResolvedValue(new Map());
    fetchWithTimeout.mockImplementation(async (url) =>
      url.endsWith('/users/@me/guilds')
        ? { ok: true, json: async () => [{ id: 'gmok-1', permissions: MANAGE_GUILD }] }
        : { ok: false, status: 429, json: async () => ({}) },
    );

    await discordGuildAccessService.findJoinedGmokGuilds('token', member);
    await discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1');
    await discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1');

    expect(userGuildCalls()).toBe(2);
  });

  test('토큰 거부(401)는 구분 코드로 던진다', async () => {
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(nextMember(), 'token', 'gmok-1'),
    ).rejects.toMatchObject({ code: DISCORD_TOKEN_REJECTED });
  });

  test('Discord 실패는 던지고 캐시에 남기지 않는다', async () => {
    const member = nextMember();
    fetchWithTimeout.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1'),
    ).rejects.toThrow();

    respondGuilds([{ id: 'gmok-1', permissions: MANAGE_GUILD }]);
    await expect(
      discordGuildAccessService.isDiscordGuildManagerNow(member, 'token', 'gmok-1'),
    ).resolves.toBe(true);
  });
});
