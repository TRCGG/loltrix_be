import { describe, test, expect } from '@jest/globals';
import {
  scopeFromQuery,
  competitionTeamNames,
  ignoresPeriod,
  NORMAL_MATCH_SCOPE,
} from '../types/matchScope.js';
import { scopeConditions, metricScopeConditions } from '../database/matchScope.js';
import { customMatch, mmrParticipantMetric } from '../database/schema.js';

describe('scopeFromQuery — 쿼리 파라미터 → 조회 범위', () => {
  test('아무것도 없으면 일반내전만 (기존 호출 불변)', () => {
    expect(scopeFromQuery({})).toEqual({ gameTypes: ['1'] });
    expect(scopeFromQuery({ gameType: '', competitionId: '' })).toEqual({ gameTypes: ['1'] });
  });

  test('competitionId만 있으면 스크림+본경기', () => {
    expect(scopeFromQuery({ competitionId: '7' })).toEqual({
      gameTypes: ['2', '3'],
      competitionId: 7,
    });
    expect(scopeFromQuery({ competitionId: 7 })).toEqual({
      gameTypes: ['2', '3'],
      competitionId: 7,
    });
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

  test('datePreset이 recent면 기간 조건이 하나 더 붙는다', () => {
    const conds = scopeConditions(customMatch, { gameTypes: ['1'], datePreset: 'recent' }, 'S13');
    expect(conds).toHaveLength(3);
    expect(conds.every(Boolean)).toBe(true);
  });

  test('datePreset이 season이거나 없으면 기간 조건이 없다', () => {
    expect(
      scopeConditions(customMatch, { gameTypes: ['1'], datePreset: 'season' }, 'S13'),
    ).toHaveLength(2);
    expect(scopeConditions(customMatch, NORMAL_MATCH_SCOPE, 'S13')).toHaveLength(2);
  });

  test('datePreset이 range면 월 범위 조건이 붙는다', () => {
    const conds = scopeConditions(
      customMatch,
      { gameTypes: ['1'], datePreset: 'range', fromMonth: '1', toMonth: '4' },
      'S13',
    );
    expect(conds).toHaveLength(3);
    expect(conds.every(Boolean)).toBe(true);
  });

  test('일반내전이 섞인 유형은 대회를 특정하지 않아도 시즌·기간을 건다', () => {
    const conds = scopeConditions(
      customMatch,
      { gameTypes: ['1', '2'], datePreset: 'recent' },
      'S13',
    );
    expect(conds).toHaveLength(3);
    expect(conds.every(Boolean)).toBe(true);
  });

  test('competitionId가 있으면 datePreset을 무시한다', () => {
    const conds = scopeConditions(
      customMatch,
      { gameTypes: ['2', '3'], competitionId: 5, datePreset: 'recent' },
      'S13',
    );
    expect(conds).toHaveLength(2);
  });
});

describe('ignoresPeriod — 시즌·기간 조건을 버리는 범위', () => {
  test('대회 유형만 조회하면 대회를 특정하지 않아도 버린다', () => {
    expect(ignoresPeriod({ gameTypes: ['2', '3'] })).toBe(true);
    expect(ignoresPeriod({ gameTypes: ['2'] })).toBe(true);
    expect(ignoresPeriod({ gameTypes: ['2', '3'], competitionId: 5 })).toBe(true);
  });

  test('일반내전이 섞여 있으면 시즌·기간을 그대로 건다', () => {
    expect(ignoresPeriod(NORMAL_MATCH_SCOPE)).toBe(false);
    expect(ignoresPeriod({ gameTypes: ['1', '2'] })).toBe(false);
  });

  test('대회 유형만 조회하면 scopeConditions에 시즌·기간이 붙지 않는다', () => {
    expect(
      scopeConditions(customMatch, { gameTypes: ['2', '3'], datePreset: 'recent' }, 'S13'),
    ).toHaveLength(1);
  });
});

describe('competitionTeamNames — 대회 밖 조회는 팀 이름을 비운다', () => {
  const names = { teamName: '1팀', opponentTeamName: '2팀' };

  test('대회를 특정한 조회는 그대로 내보낸다', () => {
    expect(competitionTeamNames({ gameTypes: ['2', '3'], competitionId: 7 }, names)).toEqual(names);
  });

  test('대회를 특정하지 않으면 칸은 남기고 값만 비운다', () => {
    expect(competitionTeamNames(NORMAL_MATCH_SCOPE, names)).toEqual({
      teamName: null,
      opponentTeamName: null,
    });
    expect(competitionTeamNames({ gameTypes: ['2', '3'] }, names)).toEqual({
      teamName: null,
      opponentTeamName: null,
    });
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
