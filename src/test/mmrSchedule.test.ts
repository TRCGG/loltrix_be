import { describe, test, expect } from '@jest/globals';
import {
  calculableCutoff,
  cutoffAtOrAfter,
  cutoffAtOrBefore,
  replayDeleteDeadline,
} from '../services/mmr/mmrSchedule.js';

// 06:00 KST = 전날 21:00 UTC
describe('MMR 컷오프', () => {
  test('저녁 업로드는 다음 날 06:00 KST 컷오프에 든다', () => {
    expect(cutoffAtOrAfter(new Date('2026-11-20T13:00:00Z')).toISOString()).toBe(
      '2026-11-20T21:00:00.000Z',
    );
  });

  test('06:00 KST 정각 업로드는 그 시각 컷오프에 든다', () => {
    expect(cutoffAtOrAfter(new Date('2026-11-20T21:00:00Z')).toISOString()).toBe(
      '2026-11-20T21:00:00.000Z',
    );
  });

  test('06:00 KST 직후 업로드는 다음 날 컷오프로 넘어간다', () => {
    expect(cutoffAtOrAfter(new Date('2026-11-20T21:00:00.001Z')).toISOString()).toBe(
      '2026-11-21T21:00:00.000Z',
    );
  });

  test('구간 끝은 현재 이전의 가장 최근 06:00 KST다', () => {
    // 12:00 KST 실행 → 당일 06:00 KST
    expect(cutoffAtOrBefore(new Date('2026-11-21T03:00:00Z')).toISOString()).toBe(
      '2026-11-20T21:00:00.000Z',
    );
    // 03:00 KST 수동 실행 → 전날 06:00 KST (진행 중인 내전을 섞지 않는다)
    expect(cutoffAtOrBefore(new Date('2026-11-20T18:00:00Z')).toISOString()).toBe(
      '2026-11-19T21:00:00.000Z',
    );
  });
});

describe('계산 가능한 구간 끝', () => {
  test('10:10 KST부터 당일 06:00 컷오프를 계산한다', () => {
    expect(calculableCutoff(new Date('2026-11-21T01:10:00Z')).toISOString()).toBe(
      '2026-11-20T21:00:00.000Z',
    );
  });

  test('그 전에 돌면(배포·재시작) 아직 지울 수 있는 경기를 집지 않도록 전날 컷오프까지만', () => {
    expect(calculableCutoff(new Date('2026-11-21T01:09:59Z')).toISOString()).toBe(
      '2026-11-19T21:00:00.000Z',
    );
    expect(calculableCutoff(new Date('2026-11-21T01:00:00Z')).toISOString()).toBe(
      '2026-11-19T21:00:00.000Z',
    );
  });
});

describe('리플 삭제 마감', () => {
  test('저녁 업로드는 다음 날 10:00 KST까지', () => {
    expect(replayDeleteDeadline(new Date('2026-11-20T13:00:00Z')).toISOString()).toBe(
      '2026-11-21T01:00:00.000Z',
    );
  });

  test('07:00 KST 업로드는 다음 날 10:00 KST까지', () => {
    expect(replayDeleteDeadline(new Date('2026-11-20T22:00:00Z')).toISOString()).toBe(
      '2026-11-22T01:00:00.000Z',
    );
  });
});
