import { jest, describe, test, expect, beforeEach } from '@jest/globals';

import type { MatchLookup } from '../services/replayGameMode.service.js';

type AsyncFn = (...args: any[]) => Promise<any>;

const getMatch = jest.fn<AsyncFn>();

jest.unstable_mockModule('../clients/riot/index.js', () => ({ getMatch }));

const { ReplayGameModeService, isAramStats, matchIdFromFileName, unsupportedGameModeError } =
  await import('../services/replayGameMode.service.js');
const { SystemError } = await import('../types/error.js');

const service = new ReplayGameModeService();

const riftStats = [
  'TOP',
  'JUNGLE',
  'MIDDLE',
  'BOTTOM',
  'UTILITY',
  'TOP',
  'JUNGLE',
  'MIDDLE',
  'BOTTOM',
  'UTILITY',
].map((TEAM_POSITION) => ({ TEAM_POSITION }));
const aramStats = Array.from({ length: 10 }, () => ({
  TEAM_POSITION: '',
  INDIVIDUAL_POSITION: 'Invalid',
}));

describe('matchIdFromFileName', () => {
  test.each([
    ['KR-8409716056.rofl', 'KR_8409716056'],
    ['KR-8409716056_1.rofl', 'KR_8409716056'],
    ['kr-8409716056.rofl', 'KR_8409716056'],
  ])('%s → %s', (fileName, expected) => {
    expect(matchIdFromFileName(fileName)).toBe(expected);
  });

  test.each(['29554bs.rofl', 'NA1-123456.rofl', '내전-KR-8409716056.rofl', 'KR-.rofl'])(
    '%s → null',
    (fileName) => {
      expect(matchIdFromFileName(fileName)).toBeNull();
    },
  );
});

describe('isAramStats', () => {
  test('협곡(포지션 10/10)은 칼바람이 아니다', () => {
    expect(isAramStats(riftStats)).toBe(false);
  });

  test('전원 포지션 빈 값이면 칼바람', () => {
    expect(isAramStats(aramStats)).toBe(true);
  });

  test('한 명이라도 포지션이 있으면 칼바람이 아니다', () => {
    expect(isAramStats([...aramStats.slice(1), { TEAM_POSITION: 'TOP' }])).toBe(false);
  });

  test('빈 배열·배열이 아닌 값은 칼바람으로 보지 않는다', () => {
    expect(isAramStats([])).toBe(false);
    expect(isAramStats(undefined)).toBe(false);
    expect(isAramStats({ TEAM_POSITION: '' })).toBe(false);
  });
});

describe('lookupMatch', () => {
  beforeEach(() => {
    getMatch.mockReset();
  });

  test('MATCHED_GAME이면 matched', async () => {
    getMatch.mockResolvedValue({ info: { gameType: 'MATCHED_GAME', queueId: 420 } });
    expect(await service.lookupMatch('KR-8409716056.rofl', 'test')).toEqual({
      result: 'matched',
      matchId: 'KR_8409716056',
    });
  });

  test('CUSTOM_GAME이면 not_matched', async () => {
    getMatch.mockResolvedValue({ info: { gameType: 'CUSTOM_GAME', queueId: 3130 } });
    expect((await service.lookupMatch('KR-8420287612.rofl', 'test')).result).toBe('not_matched');
  });

  test('404(로비 내전)는 not_found', async () => {
    getMatch.mockRejectedValue(new SystemError('upstream', 502, { code: 'riot_upstream_404' }));
    expect(await service.lookupMatch('KR-8383479948.rofl', 'test')).toEqual({
      result: 'not_found',
      matchId: 'KR_8383479948',
    });
  });

  test.each([
    [new SystemError('upstream', 502, { code: 'riot_upstream_403' }), 'riot_upstream_403'],
    [new SystemError('upstream', 502, { code: 'riot_upstream_429' }), 'riot_upstream_429'],
    [new SystemError('timeout', 504), 'status_504'],
    [new SystemError('RIOT_API_KEY 환경변수가 설정되지 않았습니다.', 500), 'status_500'],
    [new TypeError('fetch failed'), 'TypeError'],
  ])('그 외 실패는 reject하지 않고 lookup_failed + 원인(%#)', async (error, failure) => {
    getMatch.mockRejectedValue(error);
    await expect(service.lookupMatch('KR-8467256566.rofl', 'test')).resolves.toEqual({
      result: 'lookup_failed',
      matchId: 'KR_8467256566',
      failure,
    });
  });

  test('응답 본문이 멈춰도 3초에 끊고 lookup_failed', async () => {
    jest.useFakeTimers();
    try {
      getMatch.mockReturnValue(new Promise(() => {}));
      const pending = service.lookupMatch('KR-8420287612.rofl', 'test');
      await jest.advanceTimersByTimeAsync(3000);
      expect(await pending).toEqual({
        result: 'lookup_failed',
        matchId: 'KR_8420287612',
        failure: 'timeout',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('파일명에 게임 ID가 없으면 조회하지 않는다', async () => {
    expect(await service.lookupMatch('29554bs.rofl', 'test')).toEqual({
      result: 'no_match_id',
      matchId: null,
    });
    expect(getMatch).not.toHaveBeenCalled();
  });

  test('짧은 타임아웃, 429 재시도 없이 조회한다', async () => {
    getMatch.mockResolvedValue({ info: { gameType: 'CUSTOM_GAME' } });
    await service.lookupMatch('KR-8420287612.rofl', 'bot.replayUpload');
    expect(getMatch).toHaveBeenCalledWith('KR_8420287612', 'bot.replayUpload', {
      timeout: 3000,
      maxRateLimitRetry: 0,
    });
  });
});

describe('check / isRejected', () => {
  test('칼바람은 조회 없이 거절', async () => {
    const lookup = jest.fn<() => Promise<MatchLookup>>();
    const result = await service.check(aramStats, lookup, 'test');
    expect(result).toBe('aram');
    expect(lookup).not.toHaveBeenCalled();
    expect(service.isRejected(result)).toBe(true);
  });

  test.each([
    ['matched', true],
    ['not_matched', false],
    ['not_found', false],
    ['lookup_failed', false],
    ['no_match_id', false],
  ] as const)('협곡 + 조회 결과 %s → 거절 %s', async (lookupResult, rejected) => {
    const result = await service.check(
      riftStats,
      async () => ({ result: lookupResult, matchId: null }),
      'test',
    );
    expect(result).toBe(lookupResult);
    expect(service.isRejected(result)).toBe(rejected);
  });
});

describe('unsupportedGameModeError', () => {
  test('봇 계약: 400 + type unsupported-game-mode', () => {
    const error = unsupportedGameModeError();
    expect(error.status).toBe(400);
    expect(error.type).toBe('unsupported-game-mode');
  });
});
