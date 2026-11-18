import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/authHandler.js';
import type { Role } from '../types/role.js';

type RoleRow = { role: string; id?: number; guildId?: string | null };

const getActiveRolesByGuild = jest.fn<(memberId: string, guildId: string) => Promise<RoleRow[]>>();

const syncGuildManagerRoles = jest.fn<
  (memberId: string, flags: unknown, roles: unknown) => Promise<RoleRow[]>
>(async () => []);
const isDiscordGuildManagerNow =
  jest.fn<(memberId: string, accessToken: string, guildId: string) => Promise<boolean>>();

jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: {
    getActiveRolesByGuild,
    getActiveRoles: jest.fn(async () => [] as RoleRow[]),
    syncGuildManagerRoles,
  },
}));
jest.unstable_mockModule('../services/discordGuildAccess.service.js', () => ({
  discordGuildAccessService: { isDiscordGuildManagerNow },
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({
  guildService: { findGuildById: jest.fn(async () => null) },
}));

const { hasGuildRole, requireGuildRole } = await import('../middlewares/requireRole.js');
const { SystemError } = await import('../types/error.js');
const { DISCORD_TOKEN_REJECTED } = await import('../types/discordAuth.js');

const GUILD = 'guild-1';

const makeReq = (parts: Partial<AuthRequest> = {}) =>
  ({ params: { guildId: GUILD }, body: {}, query: {}, ...parts }) as AuthRequest;

const run = async (req: AuthRequest, minRole: Role) => {
  const next = jest.fn();
  await requireGuildRole(minRole, { from: 'params', key: 'guildId' })(
    req,
    {} as Response,
    next as NextFunction,
  );
  return next;
};

beforeEach(() => {
  getActiveRolesByGuild.mockReset();
  syncGuildManagerRoles.mockClear();
  isDiscordGuildManagerNow.mockReset();
});

describe('hasGuildRole', () => {
  test('봇 요청은 역할을 보지 않고 통과한다', async () => {
    await expect(hasGuildRole(makeReq({ isBot: true }), 'guildManager', GUILD)).resolves.toBe(true);
    expect(getActiveRolesByGuild).not.toHaveBeenCalled();
  });

  test('세션이 없으면 false', async () => {
    await expect(hasGuildRole(makeReq(), 'userNormal', GUILD)).resolves.toBe(false);
    expect(getActiveRolesByGuild).not.toHaveBeenCalled();
  });

  test('adminNormal 이상이면 길드 역할이 없어도 통과한다', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'adminNormal' }]);
    await expect(
      hasGuildRole(makeReq({ discordMemberId: 'member-1' }), 'guildManager', GUILD),
    ).resolves.toBe(true);
  });

  test('길드 역할이 모자라면 false', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'userUploader' }]);
    await expect(
      hasGuildRole(makeReq({ discordMemberId: 'member-1' }), 'guildManager', GUILD),
    ).resolves.toBe(false);
  });
});

describe('requireGuildRole', () => {
  test('봇 요청은 통과한다', async () => {
    const next = await run(makeReq({ isBot: true }), 'guildManager');
    expect(next).toHaveBeenCalledWith();
  });

  test('세션이 없으면 401', async () => {
    const next = await run(makeReq(), 'guildManager');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  });

  test('adminNormal 이상은 bypass한다', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'adminSuper' }]);
    const next = await run(makeReq({ discordMemberId: 'member-1' }), 'guildManager');
    expect(next).toHaveBeenCalledWith();
  });

  test('길드 역할이 모자라면 403', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'userNormal' }]);
    const next = await run(makeReq({ discordMemberId: 'member-1' }), 'guildManager');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  test('길드 역할이 충분하면 통과한다', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'guildManager' }]);
    const next = await run(makeReq({ discordMemberId: 'member-1' }), 'guildManager');
    expect(next).toHaveBeenCalledWith();
  });
});

describe('guildManager Discord 재검증', () => {
  const manager = () => makeReq({ discordMemberId: 'member-1', accessToken: 'token' });
  // getActiveRolesByGuild는 길드 행과 guildId IS NULL 행을 함께 준다.
  const rows: RoleRow[] = [
    { id: 1, guildId: GUILD, role: 'guildManager' },
    { id: 2, guildId: null, role: 'userNormal' },
  ];

  beforeEach(() => {
    getActiveRolesByGuild.mockResolvedValue(rows);
  });

  test('Discord 관리자면 통과하고 강등하지 않는다', async () => {
    isDiscordGuildManagerNow.mockResolvedValue(true);
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith();
    expect(isDiscordGuildManagerNow).toHaveBeenCalledWith('member-1', 'token', GUILD);
    expect(syncGuildManagerRoles).not.toHaveBeenCalled();
  });

  test('Discord 관리자가 아니면(강퇴·탈퇴·권한 상실) 강등하고 403', async () => {
    isDiscordGuildManagerNow.mockResolvedValue(false);
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(syncGuildManagerRoles).toHaveBeenCalledWith(
      'member-1',
      [{ guildId: GUILD, isDiscordManager: false }],
      rows,
    );
  });

  test('강등이 실패해도 403', async () => {
    isDiscordGuildManagerNow.mockResolvedValue(false);
    syncGuildManagerRoles.mockRejectedValueOnce(new Error('db down'));
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
  });

  test('Discord가 토큰을 거부하면 강등 없이 403', async () => {
    isDiscordGuildManagerNow.mockRejectedValue(
      new SystemError('Failed to fetch Discord guilds', 500, { code: DISCORD_TOKEN_REJECTED }),
    );
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 403 }));
    expect(syncGuildManagerRoles).not.toHaveBeenCalled();
  });

  test('액세스 토큰이 없으면 DB 역할로 통과한다', async () => {
    const next = await run(makeReq({ discordMemberId: 'member-1' }), 'guildManager');
    expect(next).toHaveBeenCalledWith();
    expect(isDiscordGuildManagerNow).not.toHaveBeenCalled();
  });

  test('Discord 확인이 실패하면 DB 역할로 통과한다', async () => {
    isDiscordGuildManagerNow.mockRejectedValue(new Error('429'));
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith();
    expect(syncGuildManagerRoles).not.toHaveBeenCalled();
  });

  test('신청 목록처럼 결과만 쓰는 곳은 false로 범위만 좁힌다', async () => {
    isDiscordGuildManagerNow.mockResolvedValue(false);
    await expect(hasGuildRole(manager(), 'guildManager', GUILD)).resolves.toBe(false);
  });

  test('guildManager 미만을 요구하는 검사는 Discord를 보지 않는다', async () => {
    await expect(hasGuildRole(manager(), 'userUploader', GUILD)).resolves.toBe(true);
    expect(isDiscordGuildManagerNow).not.toHaveBeenCalled();
  });

  test('admin은 Discord를 보지 않는다', async () => {
    getActiveRolesByGuild.mockResolvedValue([{ role: 'adminNormal' }]);
    const next = await run(manager(), 'guildManager');
    expect(next).toHaveBeenCalledWith();
    expect(isDiscordGuildManagerNow).not.toHaveBeenCalled();
  });
});
