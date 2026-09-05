import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { is, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * competition.service.test.ts와 같은 방식 — 체인 메서드는 자기 자신을 돌려주고 await 때 큐에서 꺼낸다.
 */
let queue: unknown[] = [];
/** db.select(...)에 넘어간 필드 — 대회 지표가 실제로 SQL에 실렸는지 보려고 모은다. */
let selects: Record<string, unknown>[] = [];
/** leftJoin 대상 — 대회 범위 밖에서 조인이 늘지 않는지 보려고 모은다. */
let joins: unknown[] = [];

const CHAIN_METHODS = [
  'from',
  'where',
  'limit',
  'offset',
  'orderBy',
  'groupBy',
  'having',
  'innerJoin',
  'as',
  '$dynamic',
];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.leftJoin = (table: unknown) => {
    joins.push(table);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const value = queue.length > 0 ? queue.shift() : [];
    return value instanceof Error
      ? Promise.reject(value).then(resolve, reject)
      : Promise.resolve(value).then(resolve, reject);
  };
  return builder;
};

const executor: Record<string, unknown> = {
  select: (fields: Record<string, unknown>) => {
    selects.push(fields);
    return makeBuilder();
  },
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getConfigOrDefault: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
    getNumberConfig: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  },
}));

const { StatisticsService } = await import('../services/statistics.service.js');
const { competitionStatSql } = await import('../database/competitionStats.js');

const service = new StatisticsService();
const GUILD = 'guild-1';
const COMPETITION = 7;

const COMPETITION_FIELDS = [
  'killParticipation',
  'damageShare',
  'goldPerMin',
  'avgVisionScore',
  'damagePerDeath',
  'deadTimePct',
  'multiKills',
];

const dialect = new PgDialect();
const render = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL).sql;
const joinedSql = () => joins.filter((table) => is(table, SQL)).map(render);

const baseRow = {
  playerCode: 'PLR_000001',
  riotName: '홍길동',
  riotNameTag: 'KR1',
  totalCount: 4,
  win: 3,
  lose: 1,
  winRate: 75,
  kda: 4.5,
  kills: 20,
  avgDpm: 620,
};

const competitionRow = {
  ...baseRow,
  killParticipation: 62.5,
  damageShare: 30.12,
  goldPerMin: 381.4,
  avgVisionScore: 21.5,
  damagePerDeath: 8123.45,
  deadTimePct: 12.3,
  multiKills: { double: 2, triple: 1, quadra: 0, penta: 0 },
};

const countRow = [{ count: 1 }];

beforeEach(() => {
  queue = [];
  selects = [];
  joins = [];
});

describe('유저 랭킹 — 대회 지표', () => {
  test('competitionId가 있으면 지표 7개를 집계하고 팀 합계·지표 조인을 붙인다', async () => {
    queue = [[competitionRow], countRow];

    const { result } = await service.getUserGameStatistics(GUILD, {
      scope: { gameTypes: ['2', '3'], competitionId: COMPETITION },
    });

    expect(Object.keys(selects[0])).toEqual(expect.arrayContaining(COMPETITION_FIELDS));
    expect(result[0]).toMatchObject({
      killParticipation: 62.5,
      damageShare: 30.12,
      multiKills: { double: 2, triple: 1, quadra: 0, penta: 0 },
    });

    const [teamTotals, metric] = joinedSql();
    expect(teamTotals).toContain('"team_totals"');
    expect(teamTotals).toContain('"custom_match"."competition_id"');
    expect(metric).toContain('"mmr_participant_metric"');
  });

  test('competitionId가 없으면 지표는 null이고 쿼리에 조인이 늘지 않는다', async () => {
    queue = [[baseRow], countRow];

    const { result } = await service.getUserGameStatistics(GUILD, {});

    expect(Object.keys(selects[0])).not.toEqual(expect.arrayContaining(COMPETITION_FIELDS));
    expect(joinedSql()).toEqual([]);
    expect(result[0]).toMatchObject({
      killParticipation: null,
      damageShare: null,
      goldPerMin: null,
      avgVisionScore: null,
      damagePerDeath: null,
      deadTimePct: null,
      multiKills: null,
    });
  });

  test('챔피언 랭킹은 대회 조회에서도 지표를 붙이지 않는다', async () => {
    queue = [[{ champName: '아리', champNameEng: 'Ahri', totalCount: 2 }], countRow];

    await service.getChampionStatistics(GUILD, {
      scope: { gameTypes: ['2', '3'], competitionId: COMPETITION },
    });

    expect(Object.keys(selects[0])).not.toEqual(expect.arrayContaining(COMPETITION_FIELDS));
    expect(joinedSql()).toEqual([]);
  });
});

describe('대회 지표 SQL 조각', () => {
  const chunks = competitionStatSql(GUILD, COMPETITION);
  const [teamTotalsJoin, metricJoin] = chunks.joins;

  test('팀 합계는 해당 대회의 경기·진영 단위로만 묶는다', () => {
    const text = render(teamTotalsJoin.table);

    expect(text).toContain('"custom_match"."competition_id"');
    expect(text).toContain('"custom_match"."guild_id"');
    expect(text).toContain(
      'GROUP BY "match_participant"."custom_match_id", "match_participant"."game_team"',
    );
    // 길드원이 아닌 참가자도 분모에 들어가야 한다.
    expect(text).not.toContain('guild_member');
    expect(render(teamTotalsJoin.on)).toContain('"match_participant"."game_team"');
  });

  test('지표 조인은 경기·플레이어로 걸고 삭제분을 뺀다', () => {
    const text = render(metricJoin.on);

    expect(text).toContain('"mmr_participant_metric"."custom_match_id"');
    expect(text).toContain('"mmr_participant_metric"."player_code"');
    expect(text).toContain('"mmr_participant_metric"."is_deleted"');
  });

  test('킬 관여율·피해 비중의 분모는 팀 합계다', () => {
    expect(render(chunks.columns.killParticipation)).toContain('SUM("team_totals"."team_kills")');
    expect(render(chunks.columns.damageShare)).toContain('SUM("team_totals"."team_damage")');
  });

  test('사망 시간 비율은 게임별 비율의 평균이 아니라 합계끼리 나눈다', () => {
    const text = render(chunks.columns.deadTimePct);

    expect(text).toContain('SUM("mmr_participant_metric"."time_spent_dead")');
    expect(text).toContain('SUM("mmr_participant_metric"."game_duration")');
    expect(text).not.toContain('AVG');
  });

  test('분모가 0이면 0, 데스가 0이면 피해 합계를 그대로 준다', () => {
    for (const key of ['killParticipation', 'damageShare', 'goldPerMin', 'deadTimePct'] as const) {
      expect(render(chunks.columns[key])).toContain('= 0 THEN 0');
    }
    const damagePerDeath = render(chunks.columns.damagePerDeath);
    const zeroDeaths = damagePerDeath.indexOf('WHEN COALESCE(SUM("match_participant"."death"), 0) = 0');
    expect(zeroDeaths).toBeGreaterThan(-1);
    expect(damagePerDeath.slice(zeroDeaths)).toContain('SUM("match_participant"."total_damage_champions")');
  });

  test('펜타킬만 match_participant에서 센다', () => {
    expect(render(chunks.columns.multiKills.penta)).toContain('"match_participant"."penta_kills"');
    expect(render(chunks.columns.multiKills.double)).toContain(
      '"mmr_participant_metric"."double_kills"',
    );
  });
});
