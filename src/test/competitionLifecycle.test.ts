import { describe, test, expect } from '@jest/globals';
import {
  COMPETITION_STATUS,
  canTransition,
  closeDateFor,
} from '../services/competitionLifecycle.js';

const { RECRUITING, IN_PROGRESS, CLOSED } = COMPETITION_STATUS;

describe('대회 상태 전이', () => {
  test.each([
    [RECRUITING, IN_PROGRESS],
    [IN_PROGRESS, RECRUITING],
    [IN_PROGRESS, CLOSED],
    [CLOSED, IN_PROGRESS],
  ])('%s → %s 은 허용된다', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  test.each([
    [RECRUITING, CLOSED],
    [CLOSED, RECRUITING],
    [RECRUITING, RECRUITING],
    [IN_PROGRESS, IN_PROGRESS],
    [CLOSED, CLOSED],
  ])('%s → %s 은 막힌다', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  test('마이그레이션 전 상태값(OPEN)은 어디로도 갈 수 없다', () => {
    expect(canTransition('OPEN', IN_PROGRESS)).toBe(false);
  });
});

describe('종료 시각', () => {
  test('종료로 가면 찍힌다', () => {
    expect(closeDateFor(CLOSED)).toBeInstanceOf(Date);
  });

  test('종료에서 나오면 비운다', () => {
    expect(closeDateFor(IN_PROGRESS)).toBeNull();
    expect(closeDateFor(RECRUITING)).toBeNull();
  });
});
