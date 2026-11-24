import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const createTournamentCodes =
  jest.fn<
    (tournamentId: number, params: Record<string, unknown>, caller: string) => Promise<string[]>
  >();
let insertedRows: Record<string, unknown>[] = [];
let selectedRows: Record<string, unknown>[] = [];

const chain = (result: () => unknown) => {
  const node: Record<string, unknown> = {};
  ['from', 'where', 'orderBy'].forEach((name) => {
    node[name] = () => node;
  });
  node.limit = async () => result();
  return node;
};

const db = {
  select: () => chain(() => selectedRows),
  insert: () => ({
    values: (rows: Record<string, unknown>[]) => {
      insertedRows = rows;
      return {
        returning: async () =>
          rows.map((row) => ({
            ...row,
            issuedDate: new Date('2026-11-24T11:02:00Z'),
            usedDate: null,
          })),
      };
    },
  }),
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db }));
jest.unstable_mockModule('../clients/riot/index.js', () => ({
  createTournamentCodes,
  registerProvider: jest.fn(),
  registerTournament: jest.fn(),
}));

const { tournamentService } = await import('../services/tournament.service.js');

const ACTIVE_TOURNAMENT = [{ providerId: 1, tournamentId: 2 }];

beforeEach(() => {
  createTournamentCodes.mockReset().mockResolvedValue(['KR-CODE-1']);
  insertedRows = [];
  selectedRows = ACTIVE_TOURNAMENT;
});

describe('issueCodes 관전 설정', () => {
  test('요청한 관전 설정을 Riot 발급과 코드 metadata에 넣는다', async () => {
    const [code] = await tournamentService.issueCodes({
      guildId: '987654321098765432',
      count: 1,
      source: 'WEB',
      spectatorType: 'LOBBYONLY',
    });

    expect(createTournamentCodes.mock.calls[0][1]).toMatchObject({ spectatorType: 'LOBBYONLY' });
    expect(insertedRows[0].metadata).toMatchObject({ spectatorType: 'LOBBYONLY' });
    expect(code.spectatorType).toBe('LOBBYONLY');
  });

  test('생략하면 ALL로 발급한다', async () => {
    await tournamentService.issueCodes({ guildId: '987654321098765432', count: 1, source: 'WEB' });

    expect(createTournamentCodes.mock.calls[0][1]).toMatchObject({ spectatorType: 'ALL' });
    expect(insertedRows[0].metadata).toMatchObject({ spectatorType: 'ALL' });
  });
});

describe('listCodes 응답', () => {
  test('관전 설정이 없는 과거 행은 ALL, 미사용 코드의 usedDate는 null', async () => {
    selectedRows = [
      {
        code: 'KR-OLD',
        guildId: '987654321098765432',
        gameType: '2',
        metadata: { guildId: '987654321098765432', channelId: '456' },
        status: 'PENDING',
        issuedDate: new Date('2026-07-20T10:00:00Z'),
        usedDate: null,
      },
    ];

    const [code] = await tournamentService.listCodes('987654321098765432', { limit: 50 });

    expect(code).toMatchObject({
      code: 'KR-OLD',
      source: 'BOT',
      channelId: '456',
      spectatorType: 'ALL',
      usedDate: null,
    });
  });
});
