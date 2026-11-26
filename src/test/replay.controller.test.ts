import { jest, describe, test, expect, beforeEach } from '@jest/globals';

type AsyncFn = (...args: any[]) => Promise<any>;

const webSave = jest.fn<AsyncFn>();
const resolveForSave = jest.fn<AsyncFn>();
const parseReplayData = jest.fn<AsyncFn>();
const checkDuplicateByHash = jest.fn<AsyncFn>();

jest.unstable_mockModule('../facade/replaySave.facade.js', () => ({
  replaySaveFacade: { webSave },
}));
jest.unstable_mockModule('../services/replay.service.js', () => ({
  ReplayService: { sanitizeFileName: (name: string) => name },
  replayService: {
    validateMagicBytes: () => true,
    parseReplayData,
    generateHash: () => 'hash',
    checkDuplicateByHash,
  },
}));
jest.unstable_mockModule('../services/competition.service.js', () => ({
  competitionService: { resolveForSave },
}));
const gameModeCheck = jest.fn<AsyncFn>();
jest.unstable_mockModule('../services/replayGameMode.service.js', () => ({
  replayGameModeService: {
    lookupMatch: jest.fn(),
    check: gameModeCheck,
    isRejected: (result: string) => result === 'aram' || result === 'matched',
  },
}));

const { webCreateReplay } = await import('../controllers/replay.controller.js');

const makeRes = () => {
  const json = jest.fn<(body: unknown) => unknown>();
  const status = jest.fn<(code: number) => { json: typeof json }>(() => ({ json }));
  return { status, json };
};

const makeReq = (gameType: string) =>
  ({
    body: { guildId: 'g1', gameType, nick: 'gmokuser/01' },
    files: [{ originalname: 'game1.rofl', buffer: Buffer.from('RIOT') }],
  }) as any;

const uploaded = async (gameType: string) => {
  const res = makeRes();
  await webCreateReplay(makeReq(gameType), res as any, jest.fn());
  return (res.json.mock.calls[0][0] as { data: { succeeded: unknown[] } }).data.succeeded;
};

describe('webCreateReplay - succeeded 항목에 자동 팀 귀속 결과 동봉', () => {
  beforeEach(() => {
    resolveForSave.mockResolvedValue(null);
    parseReplayData.mockResolvedValue({ stats: [], patchVersion: '26.13' });
    checkDuplicateByHash.mockResolvedValue(false);
    gameModeCheck.mockResolvedValue('not_matched');
  });

  test('대회 경기는 facade가 준 teamAssignment를 그대로 싣는다', async () => {
    const teamAssignment = { status: 'mercenary', blueTeamId: 1, redTeamId: null };
    webSave.mockResolvedValue({ replayCode: 'RPY-1', teamAssignment });

    expect(await uploaded('2')).toEqual([
      { fileName: 'game1.rofl', replayCode: 'RPY-1', teamAssignment },
    ]);
  });

  test('일반내전은 null', async () => {
    webSave.mockResolvedValue({ replayCode: 'RPY-2', teamAssignment: null });

    expect(await uploaded('1')).toEqual([
      { fileName: 'game1.rofl', replayCode: 'RPY-2', teamAssignment: null },
    ]);
  });
});

describe('webCreateReplay - 매칭 게임 거절', () => {
  beforeEach(() => {
    resolveForSave.mockResolvedValue(null);
    parseReplayData.mockResolvedValue({ stats: [], patchVersion: '26.13' });
    checkDuplicateByHash.mockResolvedValue(false);
    webSave.mockReset();
  });

  test.each(['aram', 'matched'])(
    '%s는 저장하지 않고 unsupported_game_mode로 실패 처리',
    async (result) => {
      gameModeCheck.mockResolvedValue(result);
      const res = makeRes();
      await webCreateReplay(makeReq('1'), res as any, jest.fn());

      const { data } = res.json.mock.calls[0][0] as {
        data: { succeeded: unknown[]; failed: unknown[] };
      };
      expect(data.failed).toEqual([{ fileName: 'game1.rofl', reason: 'unsupported_game_mode' }]);
      expect(data.succeeded).toEqual([]);
      expect(webSave).not.toHaveBeenCalled();
      expect(checkDuplicateByHash).not.toHaveBeenCalled();
    },
  );
});
