import { jest, describe, test, expect, beforeEach } from '@jest/globals';

type AsyncFn = (...args: any[]) => Promise<any>;

const calls: string[] = [];
const transaction = jest.fn<AsyncFn>(async () => ({ replayCode: 'RPY-1' }));
const getRawData = jest.fn<AsyncFn>();
const lookupMatch = jest.fn<AsyncFn>();
const check = jest.fn<AsyncFn>();

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: { transaction } }));
jest.unstable_mockModule('../services/guild.service.js', () => ({ guildService: {} }));
jest.unstable_mockModule('../services/replay.service.js', () => ({
  replayService: { getRawData },
}));
jest.unstable_mockModule('../services/riotAccount.service.js', () => ({ riotAccountService: {} }));
jest.unstable_mockModule('../services/customMatch.service.js', () => ({ customMatchService: {} }));
jest.unstable_mockModule('../services/matchParticipant.service.js', () => ({
  matchParticipantService: {},
}));
jest.unstable_mockModule('../services/competitionTeam.service.js', () => ({
  competitionTeamService: {},
}));
jest.unstable_mockModule('../services/mmrMetric.service.js', () => ({ mmrMetricService: {} }));
jest.unstable_mockModule('../services/guildMember.service.js', () => ({ guildMemberService: {} }));

const gameMode = await import('../services/replayGameMode.service.js');
jest.unstable_mockModule('../services/replayGameMode.service.js', () => ({
  ...gameMode,
  replayGameModeService: {
    lookupMatch,
    check,
    isRejected: gameMode.replayGameModeService.isRejected,
  },
}));

const { replaySaveFacade } = await import('../facade/replaySave.facade.js');

const fileData = {
  fileName: 'KR-8409716056',
  fileUrl: 'https://cdn.discordapp.com/attachments/1/2/KR-8409716056.rofl',
  createUser: 'user',
  guild: { id: 'g1' },
} as any;

describe('allSave — 게임 모드 검증', () => {
  beforeEach(() => {
    calls.length = 0;
    lookupMatch.mockImplementation(async () => {
      calls.push('lookup');
      return { result: 'not_found', matchId: 'KR_8409716056' };
    });
    getRawData.mockImplementation(async () => {
      calls.push('download');
      return { rawData: [], patchVersion: '26.20' };
    });
    check.mockImplementation(async (_stats: unknown, lookup: () => Promise<{ result: string }>) => {
      return (await lookup()).result;
    });
  });

  test('조회를 다운로드보다 먼저 띄우고, 봇이 보낸 파일명 그대로 넘긴다', async () => {
    await replaySaveFacade.allSave(fileData, 'bot.replayUpload');
    expect(calls).toEqual(['lookup', 'download']);
    expect(lookupMatch).toHaveBeenCalledWith('KR-8409716056', 'bot.replayUpload');
  });

  test.each(['aram', 'matched'])(
    '%s면 트랜잭션을 열지 않고 unsupported-game-mode 400',
    async (result) => {
      check.mockResolvedValue(result);
      await expect(replaySaveFacade.allSave(fileData, 'bot.replayUpload')).rejects.toMatchObject({
        status: 400,
        type: 'unsupported-game-mode',
      });
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  test.each(['not_matched', 'not_found', 'lookup_failed', 'no_match_id'])(
    '%s면 그대로 저장한다',
    async (result) => {
      check.mockResolvedValue(result);
      await replaySaveFacade.allSave(fileData, 'bot.replayUpload');
      expect(transaction).toHaveBeenCalledTimes(1);
    },
  );

  test('다운로드가 실패하면 그 에러가 그대로 나간다', async () => {
    getRawData.mockRejectedValue(new Error('cdn 504'));
    await expect(replaySaveFacade.allSave(fileData, 'bot.replayUpload')).rejects.toThrow('cdn 504');
    expect(check).not.toHaveBeenCalled();
  });
});
