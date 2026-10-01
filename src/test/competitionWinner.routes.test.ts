import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express, { NextFunction, Request, Response } from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AuthRequest } from '../middlewares/authHandler.js';
import { BusinessError } from '../types/error.js';
import { CompetitionTeamUpdateInput } from '../types/competition.js';

const updateTeam =
  jest.fn<
    (
      guildId: string,
      competitionId: number,
      teamId: number,
      input: CompetitionTeamUpdateInput,
    ) => Promise<unknown>
  >();
const getRoles = jest.fn<(memberId: string, guildId: string) => Promise<{ role: string }[]>>();

jest.unstable_mockModule('../services/competition.service.js', () => ({ competitionService: {} }));
jest.unstable_mockModule('../services/competitionTeam.service.js', () => ({
  competitionTeamService: { updateTeam },
  visibleApplicationStatus: jest.fn(),
}));
jest.unstable_mockModule('../services/competitionPlayer.service.js', () => ({
  competitionPlayerService: {},
}));
jest.unstable_mockModule('../services/statistics.service.js', () => ({ statisticsService: {} }));
jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: { getActiveRolesByGuild: getRoles },
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({ guildService: {} }));

const { default: router } = await import('../routes/competition.routes.js');
let server: Server;
let endpoint: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: AuthRequest, _res, next) => {
    req.discordMemberId = req.get('x-test-member');
    next();
  });
  app.use('/api/competitions', router);
  // Express는 인자 네 개로 오류 처리 미들웨어를 구분한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: BusinessError, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status ?? 500).json({ type: error.type });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const guildId = Buffer.from('guild-1').toString('base64');
  endpoint = `http://127.0.0.1:${port}/api/competitions/${guildId}/7/teams/5`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  getRoles.mockReset().mockResolvedValue([{ role: 'guildManager' }]);
  updateTeam.mockReset().mockImplementation(async (_guildId, _id, teamId, input) => ({
    id: teamId,
    isWinner: input.isWinner ?? false,
  }));
});

const patch = (body: unknown, member: string | null = 'member-1') =>
  fetch(endpoint, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(member ? { 'x-test-member': member } : {}),
    },
    body: JSON.stringify(body),
  });

describe('팀 수정 API의 우승 여부', () => {
  test.each([true, false])('운영진이 우승 여부를 지정·해제한다: %s', async (isWinner) => {
    const res = await patch({ isWinner, actorMemberId: 'spoofed-member' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'success', data: { id: 5, isWinner } });
    expect(updateTeam).toHaveBeenCalledWith('guild-1', 7, 5, { isWinner });
    expect(getRoles).toHaveBeenCalledWith('member-1', 'guild-1');
  });

  test.each([null, 'true', 0, 1, []])('잘못된 우승 여부는 400: %j', async (isWinner) => {
    const res = await patch({ isWinner });
    expect(res.status).toBe(400);
    expect(updateTeam).not.toHaveBeenCalled();
  });

  test('우승 여부 없이 기존 이름 수정 요청도 유지된다', async () => {
    const res = await patch({ name: '수정한 팀' });
    expect(res.status).toBe(200);
    expect(updateTeam).toHaveBeenCalledWith('guild-1', 7, 5, { name: '수정한 팀' });
  });

  test('별도 우승팀 API는 제공하지 않는다', async () => {
    const res = await fetch(endpoint.replace('/teams/5', '/winner'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-member': 'member-1' },
      body: JSON.stringify({ teamId: 5 }),
    });
    expect(res.status).toBe(404);
    expect(updateTeam).not.toHaveBeenCalled();
  });

  test('비로그인 요청은 401', async () => {
    const res = await patch({ isWinner: true }, null);
    expect(res.status).toBe(401);
    expect(updateTeam).not.toHaveBeenCalled();
  });

  test('일반 유저는 403', async () => {
    getRoles.mockResolvedValue([{ role: 'userNormal' }]);
    const res = await patch({ isWinner: true });
    expect(res.status).toBe(403);
    expect(updateTeam).not.toHaveBeenCalled();
  });

  test('다른 대회의 팀 거절을 HTTP 404로 전달한다', async () => {
    updateTeam.mockRejectedValue(
      new BusinessError('team not found', 404, { type: 'team-not-found' }),
    );
    const res = await patch({ isWinner: true });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ type: 'team-not-found' });
  });
});
