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
let havings: unknown[] = [];
let orders: unknown[][] = [];
let wheres: unknown[] = [];

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
  builder.having = (condition: unknown) => {
    havings.push(condition);
    return builder;
  };
  builder.orderBy = (...criteria: unknown[]) => {
    orders.push(criteria);
    return builder;
  };
  builder.where = (condition: unknown) => {
    wheres.push(condition);
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
  havings = [];
  orders = [];
  wheres = [];
});

describe('우수 성적 유저 랭킹', () => {
  test('Wilson 모드는 전 포지션을 합산하고 설정된 최소 판수와 동률 정렬을 적용한다', async () => {
    queue = [[{ ...baseRow, wilsonScore: 0.42 }], countRow];

    const { result } = await service.getUserGameStatistics(GUILD, {
      sortBy: 'wilsonScore',
      position: 'ALL',
    });

    expect(selects[0]).toHaveProperty('wilsonScore');
    expect(selects[0]).not.toHaveProperty('position');
    expect(result[0]).toMatchObject({ totalCount: 4, winRate: 75, wilsonScore: 0.42 });
    expect(havings).toHaveLength(2);
    expect(dialect.sqlToQuery(havings[0] as SQL)).toMatchObject({ params: [10] });
    expect(orders[0]).toHaveLength(3);
  });

  test('Wilson 모드는 챔피언과 특정 포지션을 최소 판수 집계 전에 거른다', async () => {
    queue = [[], [{ count: 0 }]];
    await service.getUserGameStatistics(GUILD, {
      sortBy: 'wilsonScore',
      championName: '아리',
      position: 'MID',
    });

    const userQuery = selects[0];
    expect(userQuery).not.toHaveProperty('position');
    expect(havings).toHaveLength(2);
    expect(render(wheres[0])).toContain('"champion"."champ_name"');
  });

  test('기존 유저 조회는 Wilson 점수를 추가하지 않는다', async () => {
    queue = [[baseRow], countRow];
    await service.getUserGameStatistics(GUILD, { sortBy: 'totalCount', position: 'ALL' });

    expect(selects[0]).toHaveProperty('position');
    expect(selects[0]).not.toHaveProperty('wilsonScore');
  });
});

describe('클랜 챔피언 리더보드', () => {
  test('픽률은 경기 중복을 제거하며 최소 판수와 ALL 라인 분할을 적용하지 않는다', async () => {
    queue = [[{ champName: '아리', pickRate: 75 }], countRow];
    await service.getChampionStatistics(GUILD, { sortBy: 'pickRate', position: 'ALL' });
    const fields = selects.find((selection) => 'pickRate' in selection)!;
    expect(fields).toHaveProperty('totalMatches');
    expect(fields).not.toHaveProperty('position');
    expect(render(fields.matchCount)).toContain(
      'COUNT(DISTINCT "match_participant"."custom_match_id")',
    );
    expect(havings.every((condition) => condition === undefined)).toBe(true);
  });

  test('메타는 설정된 최소 판수를 적용하고 선택한 포지션을 표시한다', async () => {
    queue = [[], [{ count: 0 }]];
    const result = await service.getChampionStatistics(GUILD, {
      sortBy: 'wilsonScore',
      position: 'MID',
    });
    expect(selects.find((selection) => 'wilsonScore' in selection)).toHaveProperty('position');
    expect(havings).toHaveLength(2);
    expect(dialect.sqlToQuery(havings[0] as SQL)).toMatchObject({ params: [10] });
    expect(result).toEqual({ result: [], totalCount: 0 });
  });

  test('기존 ALL 통계의 라인별 집계와 응답 필드는 유지한다', async () => {
    queue = [[], [{ count: 0 }]];
    await service.getChampionStatistics(GUILD, { position: 'ALL' });
    expect(selects[0]).toHaveProperty('position');
    expect(selects[0]).not.toHaveProperty('pickRate');
    expect(selects[0]).not.toHaveProperty('wilsonScore');
  });
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

    const whereQuery = dialect.sqlToQuery(wheres[0] as SQL);
    expect(whereQuery.sql).toContain('"guild_member"."guild_id" = $1');
    expect(whereQuery.sql).toContain('"custom_match"."guild_id" = $2');
    expect(whereQuery.params.slice(0, 2)).toEqual([GUILD, GUILD]);

    const competitionPlaceholder = whereQuery.sql.match(
      /"custom_match"\."competition_id" = \$(\d+)/,
    );
    expect(competitionPlaceholder).not.toBeNull();
    expect(whereQuery.params[Number(competitionPlaceholder?.[1]) - 1]).toBe(COMPETITION);
  });

  test('competitionId가 없으면 지표를 select에도 결과에도 싣지 않는다', async () => {
    queue = [[baseRow], countRow];

    const { result } = await service.getUserGameStatistics(GUILD, {});

    expect(Object.keys(selects[0])).not.toEqual(expect.arrayContaining(COMPETITION_FIELDS));
    expect(joinedSql()).toEqual([]);
    expect(result[0]).toEqual(baseRow);
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
    const zeroDeaths = damagePerDeath.indexOf(
      'WHEN COALESCE(SUM("match_participant"."death"), 0) = 0',
    );
    expect(zeroDeaths).toBeGreaterThan(-1);
    expect(damagePerDeath.slice(zeroDeaths)).toContain(
      'SUM("match_participant"."total_damage_champions")',
    );
  });

  test('펜타킬만 match_participant에서 센다', () => {
    expect(render(chunks.columns.multiKills.penta)).toContain('"match_participant"."penta_kills"');
    expect(render(chunks.columns.multiKills.double)).toContain(
      '"mmr_participant_metric"."double_kills"',
    );
  });
});
