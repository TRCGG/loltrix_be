import { describe, test, expect } from '@jest/globals';
import { scopeFromQuery, NORMAL_MATCH_SCOPE } from '../types/matchScope.js';
import { scopeConditions, metricScopeConditions } from '../database/matchScope.js';
import { customMatch, mmrParticipantMetric } from '../database/schema.js';

describe('scopeFromQuery — 쿼리 파라미터 → 조회 범위', () => {
  test('아무것도 없으면 일반내전만 (기존 호출 불변)', () => {
    expect(scopeFromQuery({})).toEqual({ gameTypes: ['1'] });
    expect(scopeFromQuery({ gameType: '', competitionId: '' })).toEqual({ gameTypes: ['1'] });
  });

  test('competitionId만 있으면 스크림+본경기', () => {
    expect(scopeFromQuery({ competitionId: '7' })).toEqual({ gameTypes: ['2', '3'], competitionId: 7 });
    expect(scopeFromQuery({ competitionId: 7 })).toEqual({ gameTypes: ['2', '3'], competitionId: 7 });
  });

  test('gameType은 콤마 구분·공백·중복을 정리하고 1|2|3 외는 버린다', () => {
    expect(scopeFromQuery({ gameType: '2, 2,3' }).gameTypes).toEqual(['2', '3']);
    expect(scopeFromQuery({ gameType: '9,x' }).gameTypes).toEqual(['1']);
    expect(scopeFromQuery({ gameType: '1', competitionId: '3' })).toEqual({
      gameTypes: ['1'],
      competitionId: 3,
    });
  });
});

describe('scopeConditions — custom_match용 WHERE 조각', () => {
  test('기본 scope는 유형 조건 하나 + 시즌', () => {
    const conds = scopeConditions(customMatch, NORMAL_MATCH_SCOPE, 'S13');
    expect(conds).toHaveLength(2);
    expect(conds.every(Boolean)).toBe(true);
  });

  test('시즌이 없으면 유형 조건만 (전체 시즌)', () => {
    const [type, season] = scopeConditions(customMatch, NORMAL_MATCH_SCOPE, null);
    expect(type).toBeDefined();
    expect(season).toBeUndefined();
  });

  test('competitionId가 있으면 시즌을 버리고 대회 조건을 쓴다', () => {
    const [type, competition] = scopeConditions(
      customMatch,
      { gameTypes: ['2', '3'], competitionId: 5 },
      'S13',
    );
    expect(type).toBeDefined();
    expect(competition).toBeDefined();
  });
});

describe('metricScopeConditions — mmr_participant_metric용 (대회 필터 없음)', () => {
  test('유형 + 시즌만', () => {
    const conds = metricScopeConditions(mmrParticipantMetric, ['1'], 'S13');
    expect(conds).toHaveLength(2);
    expect(conds.every(Boolean)).toBe(true);
    expect(metricScopeConditions(mmrParticipantMetric, ['2', '3'], null)[1]).toBeUndefined();
  });
});
