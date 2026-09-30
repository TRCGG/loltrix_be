import { jest, describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

const echo = (req: Request, res: Response) => res.json({ body: req.body, query: req.query });
const controllerExports = (names: string[]) =>
  Object.fromEntries(names.map((name) => [name, echo]));
const pass = (_req: Request, _res: Response, next: NextFunction) => next();
jest.unstable_mockModule('../middlewares/requireRole.js', () => ({
  requireGuildRole: () => pass,
  requireUploadPermission: () => pass,
}));
jest.unstable_mockModule('../controllers/competition.controller.js', () =>
  controllerExports([
    'addTeamMember',
    'assignMatchTeams',
    'changeCompetitionStatus',
    'changeMatchGameType',
    'closeCompetition',
    'createApplication',
    'createCompetition',
    'createTeam',
    'decideApplications',
    'deleteCompetition',
    'deleteMyApplication',
    'deleteTeam',
    'exportApplicationsCsv',
    'getCompetitionDetail',
    'getMyApplication',
    'getStandings',
    'getTeamHeadToHead',
    'getTeamRecords',
    'listApplications',
    'listPlayerCompetitions',
    'listCompetitionMatches',
    'listCompetitions',
    'listTeams',
    'removeTeamMember',
    'resolveCompetition',
    'saveRoster',
    'updateCompetition',
    'updateMyApplication',
    'updateTeam',
  ]),
);
jest.unstable_mockModule('../controllers/replay.controller.js', () =>
  controllerExports(['createReplay', 'getReplayList', 'webCreateReplay']),
);
jest.unstable_mockModule('../controllers/tournament.controller.js', () =>
  controllerExports(['issueCodes', 'getNextCode']),
);
jest.unstable_mockModule('../controllers/matchParticipant.controller.js', () =>
  controllerExports([
    'getRecentGames',
    'getMatchDashboard',
    'getMostPicks',
    'getGameDetail',
    'deleteMatch',
  ]),
);
jest.unstable_mockModule('../controllers/h2h.controller.js', () =>
  controllerExports(['getFrequentOpponents', 'getH2hDetail']),
);
jest.unstable_mockModule('../controllers/statistics.controller.js', () =>
  controllerExports(['getUserGameStats', 'getChampionStats']),
);
jest.unstable_mockModule('../controllers/clanLeaderboard.controller.js', () =>
  controllerExports([
    'getChampionCombinations',
    'getDuos',
    'getActivity',
    'getRisingStars',
    'getHighlights',
    'getWinStreaks',
    'getClanLeaderboardUsers',
    'getClanLeaderboardChampions',
  ]),
);
const getUserGameStatistics = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const getChampionStatistics = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.unstable_mockModule('../services/statistics.service.js', () => ({
  statisticsService: { getUserGameStatistics, getChampionStatistics },
}));
jest.unstable_mockModule('../services/competition.service.js', () => ({
  competitionService: { assertExists: jest.fn(async () => undefined) },
}));

const app = express();
app.use(express.json());
for (const [mount, module] of [
  ['competitions', 'competition.routes'],
  ['replays', 'replay.routes'],
  ['tournament', 'tournament.routes'],
  ['matches', 'matchParticipant.routes'],
  ['h2h', 'h2h.routes'],
  ['statistics', 'statistics.route'],
]) {
  const { default: router } = await import(`../routes/${module}.js`);
  app.use(`/${mount}`, router);
}
const server = createServer(app);
let baseUrl: string;
const guild = Buffer.from('guild-1').toString('base64');

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  jest.clearAllMocks();
  getUserGameStatistics.mockResolvedValue({ result: [], totalCount: 0 });
  getChampionStatistics.mockResolvedValue({ result: [], totalCount: 0 });
});

describe('예선·본선 경기 유형 HTTP 검증', () => {
  test.each(['4', '2,3,4'])('조회 API가 gameType=%s를 허용한다', async (gameType) => {
    for (const path of [
      `/competitions/${guild}/7/statistics/users`,
      `/competitions/${guild}/7/statistics/champions`,
      `/matches/${guild}/player/games`,
      `/matches/${guild}/player/dashboard`,
      `/matches/${guild}/player/most-picks`,
      `/statistics/${guild}/users`,
      `/statistics/${guild}/champions`,
      `/h2h/${guild}/frequent?riotName=player`,
      `/h2h/${guild}?riotName1=one&riotName2=two`,
    ]) {
      const response = await fetch(
        `${baseUrl}${path}${path.includes('?') ? '&' : '?'}gameType=${gameType}`,
      );
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
    }
    expect(getUserGameStatistics).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({
        scope: { gameTypes: gameType.split(','), competitionId: 7 },
      }),
    );
  });

  test('대회 통계 기본 범위는 세 유형이고 일반내전·잘못된 유형은 거부한다', async () => {
    const path = `/competitions/${guild}/7/statistics/users`;
    expect((await fetch(`${baseUrl}${path}`)).status).toBe(200);
    expect(getUserGameStatistics).toHaveBeenCalledWith(
      'guild-1',
      expect.objectContaining({
        scope: { gameTypes: ['2', '3', '4'], competitionId: 7 },
      }),
    );
    for (const gameType of ['1', '2,5', '4,']) {
      expect((await fetch(`${baseUrl}${path}?gameType=${gameType}`)).status).toBe(400);
    }
  });

  test.each(['3', '4'])('대회 경기 유형을 %s로 변경할 수 있다', async (gameType) => {
    const response = await fetch(`${baseUrl}/competitions/${guild}/7/matches/game-type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customMatchIds: ['m1'], gameType }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { gameType } });
  });

  test('대회 경기를 일반내전으로 변경할 수 없다', async () => {
    const response = await fetch(`${baseUrl}/competitions/${guild}/7/matches/game-type`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customMatchIds: ['m1'], gameType: '1' }),
    });
    expect(response.status).toBe(400);
  });

  test('리플 저장·웹 업로드·토너먼트 발급이 본선 유형 4를 전달한다', async () => {
    for (const [path, body] of [
      [
        '/replays',
        {
          fileName: 'main.rofl',
          fileUrl: 'web',
          createUser: 'user',
          guild: { id: 'g1', name: 'guild' },
          gameType: '4',
          competitionId: 7,
        },
      ],
      ['/tournament/codes', { guildId: 'g1', count: 1, gameType: '4' }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ body: { gameType: '4' } });
    }
    const form = new FormData();
    form.set('guildId', 'g1');
    form.set('nick', 'user');
    form.set('gameType', '4');
    form.set('competitionId', '7');
    form.set('files', new Blob(['replay']), 'main.rofl');
    const response = await fetch(`${baseUrl}/replays/web`, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ body: { gameType: '4', competitionId: 7 } });
  });
});
