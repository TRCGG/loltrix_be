import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import type { Response, NextFunction } from 'express';
import type { AuthRequest } from '../middlewares/authHandler.js';
import type { Role } from '../types/role.js';

type RoleRow = { role: string };

const getActiveRolesByGuild = jest.fn<(memberId: string, guildId: string) => Promise<RoleRow[]>>();

jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: {
    getActiveRolesByGuild,
    getActiveRoles: jest.fn(async () => [] as RoleRow[]),
  },
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({
  guildService: { findGuildById: jest.fn(async () => null) },
}));

const { hasGuildRole, requireGuildRole } = await import('../middlewares/requireRole.js');

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
