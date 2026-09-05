import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { getTableName } from 'drizzle-orm';

/**
 * DB는 결과 큐로 대신한다 — 쿼리 빌더의 모든 체인 메서드는 자기 자신을 돌려주고,
 * await 하는 순간 큐에서 하나를 꺼낸다(Error를 넣으면 그 자리에서 던진다).
 * 따라서 각 테스트의 큐는 서비스가 실행하는 쿼리 순서 그대로다.
 */
let queue: unknown[] = [];
/** insert/update에 넘어간 값 — 저장 직전 정규화와 감사 로그 내용을 보려고 모은다. */
let written: unknown[] = [];
/** .for(...)로 요청한 행 잠금 */
let locks: unknown[] = [];
/** 실행된 쓰기 문을 `op table` 형태로 — 캐스케이드가 어느 테이블까지 갔는지 보려고 모은다. */
let statements: string[] = [];

const CHAIN_METHODS = [
  'from',
  'where',
  'limit',
  'returning',
  'orderBy',
  'innerJoin',
  'leftJoin',
  'groupBy',
  'onConflictDoUpdate',
  'onConflictDoNothing',
];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.values = (value: unknown) => {
    written.push(value);
    return builder;
  };
  builder.set = (value: unknown) => {
    written.push(value);
    return builder;
  };
  builder.for = (mode: unknown) => {
    locks.push(mode);
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

const record = (op: string) => (table: unknown) => {
  statements.push(`${op} ${getTableName(table as Parameters<typeof getTableName>[0])}`);
  return makeBuilder();
};

const executor: Record<string, unknown> = {
  select: () => makeBuilder(),
  selectDistinct: () => makeBuilder(),
  insert: record('insert'),
  update: record('update'),
  delete: record('delete'),
  transaction: async (callback: (tx: unknown) => unknown) => callback(executor),
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getConfigOrDefault: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  },
}));

const { CompetitionService } = await import('../services/competition.service.js');

const service = new CompetitionService();
const GUILD = 'guild-1';
const COMPETITION = 7;
const ACTOR = { memberId: 'member-1', source: 'web' as const };

const competitionRow = (status: string, extra: Record<string, unknown> = {}) => [
  { id: COMPETITION, guildId: GUILD, name: '멸망전 1회', status, approvalRequired: true, ...extra },
];

const uniqueViolation = (constraint: string) =>
  Object.assign(new Error('duplicate key value'), { cause: { code: '23505', constraint } });

const expectStatus = (promise: Promise<unknown>, status: number, type: string) =>
  expect(promise).rejects.toMatchObject({ status, type });

const auditOf = (index: number) =>
  written[index] as { eventType: string; detail: Record<string, unknown> };

beforeEach(() => {
  queue = [];
  written = [];
  locks = [];
  statements = [];
});

describe('상태 전이', () => {
  test('허용되지 않는 전이는 거부한다 (409)', async () => {
    queue = [competitionRow('CLOSED')];
    await expectStatus(
      service.changeStatus(GUILD, COMPETITION, 'RECRUITING', ACTOR),
      409,
      'competition-invalid-transition',
    );
  });

  test('길드에 이미 진행중 대회가 있으면 409로 돌려준다', async () => {
    queue = [competitionRow('RECRUITING'), uniqueViolation('uq_competition_guild_in_progress')];
    await expectStatus(
      service.changeStatus(GUILD, COMPETITION, 'IN_PROGRESS', ACTOR),
      409,
      'competition-in-progress-exists',
    );
  });

  test('종료는 competitionClose로 남긴다', async () => {
    queue = [competitionRow('IN_PROGRESS'), competitionRow('CLOSED')];
    await service.changeStatus(GUILD, COMPETITION, 'CLOSED', ACTOR);

    expect((written[0] as { closeDate: Date | null }).closeDate).toBeInstanceOf(Date);
    expect(auditOf(1).eventType).toBe('competitionClose');
  });

  test('그 외 전이는 competitionStatusChange에 from·to를 남긴다', async () => {
    queue = [competitionRow('RECRUITING'), competitionRow('IN_PROGRESS')];
    await service.changeStatus(GUILD, COMPETITION, 'IN_PROGRESS', ACTOR);

    expect(auditOf(1).eventType).toBe('competitionStatusChange');
    expect(auditOf(1).detail).toMatchObject({
      competitionId: COMPETITION,
      from: 'RECRUITING',
      to: 'IN_PROGRESS',
    });
  });

  test('종료에서 나오면 closeDate를 비운다', async () => {
    queue = [competitionRow('CLOSED', { closeDate: new Date() }), competitionRow('IN_PROGRESS')];
    await service.changeStatus(GUILD, COMPETITION, 'IN_PROGRESS', ACTOR);

    expect(written[0]).toEqual({ status: 'IN_PROGRESS', closeDate: null });
  });

  test('대상 행을 FOR UPDATE로 잡고 검사한다', async () => {
    queue = [competitionRow('RECRUITING'), competitionRow('IN_PROGRESS')];
    await service.changeStatus(GUILD, COMPETITION, 'IN_PROGRESS', ACTOR);

    expect(locks).toEqual(['update']);
  });
});

describe('수정', () => {
  test('바꿀 필드가 없으면 400', async () => {
    await expectStatus(
      service.update(GUILD, COMPETITION, {}, ACTOR),
      400,
      'competition-update-empty',
    );
  });

  test('이름은 공백을 정규화해 저장한다', async () => {
    queue = [competitionRow('RECRUITING'), competitionRow('RECRUITING')];
    await service.update(GUILD, COMPETITION, { name: '  멸망전   2회 ' }, ACTOR);

    expect(written[0]).toEqual({ name: '멸망전 2회' });
  });

  test('감사 로그의 changes에는 실제로 달라진 필드만 담는다', async () => {
    queue = [competitionRow('RECRUITING'), competitionRow('RECRUITING')];
    await service.update(
      GUILD,
      COMPETITION,
      { name: '멸망전 1회', approvalRequired: false },
      ACTOR,
    );

    expect(auditOf(1).detail.changes).toEqual({
      approvalRequired: { from: true, to: false },
    });
  });

  test('값이 그대로면 수정도 감사 로그도 하지 않는다', async () => {
    queue = [competitionRow('RECRUITING')];
    const result = await service.update(
      GUILD,
      COMPETITION,
      { name: '멸망전 1회', approvalRequired: true },
      ACTOR,
    );

    expect(written).toEqual([]);
    expect(result).toEqual(competitionRow('RECRUITING')[0]);
  });
});

describe('리플이 붙을 대회 해석', () => {
  test('일반내전에 competitionId를 주면 400', async () => {
    await expectStatus(
      service.resolveForSave(GUILD, '1', COMPETITION),
      400,
      'competition-requires-game-type',
    );
  });

  test('지정한 대회가 모집중이면 400', async () => {
    queue = [competitionRow('RECRUITING')];
    await expectStatus(
      service.resolveForSave(GUILD, '2', COMPETITION),
      400,
      'competition-not-open',
    );
  });

  test('진행중 대회가 없으면 400', async () => {
    queue = [[]];
    await expectStatus(service.resolveForSave(GUILD, '2', null), 400, 'no-open-competition');
  });
});

describe('대회명 해석', () => {
  test('이름이 없으면 진행중 대회를 먼저 고른다', async () => {
    queue = [competitionRow('IN_PROGRESS')];
    const result = await service.resolveByName(GUILD);

    expect(result.match).toMatchObject({ id: COMPETITION, status: 'IN_PROGRESS' });
  });

  test('진행중이 없으면 최근 대회로 내려간다', async () => {
    queue = [[], competitionRow('CLOSED', { id: 99 })];
    const result = await service.resolveByName(GUILD);

    expect(result.match).toMatchObject({ id: 99, status: 'CLOSED' });
  });
});

describe('삭제', () => {
  const NAME = '멸망전 1회';
  const matchRows = (...ids: string[]) => ids.map((id) => ({ id }));

  test('확인용 이름이 다르면 400이고 아무것도 건드리지 않는다', async () => {
    queue = [competitionRow('CLOSED')];
    await expectStatus(
      service.remove(GUILD, COMPETITION, '멸망전 2회', ACTOR),
      400,
      'competition-name-mismatch',
    );

    expect(statements).toEqual([]);
    expect(written).toEqual([]);
  });

  test('앞뒤·연속 공백만 다른 이름은 통과한다', async () => {
    queue = [competitionRow('CLOSED'), []];
    await service.remove(GUILD, COMPETITION, '  멸망전   1회 ', ACTOR);

    expect(statements).toContain('delete competition');
  });

  test('활성 경기를 !drop과 같은 캐스케이드로 함께 지운다', async () => {
    queue = [competitionRow('CLOSED'), matchRows('m1', 'm2'), matchRows('m1', 'm2')];
    const result = await service.remove(GUILD, COMPETITION, NAME, ACTOR);

    expect(statements).toEqual([
      'update custom_match',
      'update match_participant',
      'update mmr_participant_metric',
      'update replay',
      'delete competition_match_team',
      'delete competition_match_team',
      'update custom_match',
      'update replay',
      'delete competition',
      'insert guild_audit_log',
    ]);
    expect(written.slice(0, 4)).toEqual(
      Array(4).fill({ isDeleted: true, updateDate: expect.any(Date) }),
    );
    expect(written.slice(4, 6)).toEqual([{ competitionId: null }, { competitionId: null }]);
    expect(result.deletedMatchCount).toBe(2);
  });

  test('감사 로그 한 줄에 지운 경기 id와 수를 남긴다', async () => {
    queue = [competitionRow('CLOSED'), matchRows('m1', 'm2'), matchRows('m1', 'm2')];
    await service.remove(GUILD, COMPETITION, NAME, ACTOR);

    expect(statements.filter((s) => s === 'insert guild_audit_log')).toHaveLength(1);
    expect(auditOf(6).eventType).toBe('competitionDelete');
    expect(auditOf(6).detail).toEqual({
      competitionId: COMPETITION,
      name: NAME,
      deletedMatchIds: ['m1', 'm2'],
      deletedMatchCount: 2,
      source: 'web',
    });
  });

  test('활성 경기가 없으면 경기 캐스케이드 없이 대회만 지운다', async () => {
    queue = [competitionRow('CLOSED'), []];
    const result = await service.remove(GUILD, COMPETITION, NAME, ACTOR);

    expect(statements).toEqual([
      'delete competition_match_team',
      'update custom_match',
      'update replay',
      'delete competition',
      'insert guild_audit_log',
    ]);
    expect(auditOf(2).detail).toMatchObject({ deletedMatchIds: [], deletedMatchCount: 0 });
    expect(result.deletedMatchCount).toBe(0);
  });

  test('사이에 !drop이 들어와 덜 뒤집히면 감사 로그·응답 수도 뒤집힌 것만 센다', async () => {
    queue = [competitionRow('CLOSED'), matchRows('m1', 'm2'), matchRows('m1')];
    const result = await service.remove(GUILD, COMPETITION, NAME, ACTOR);

    expect(auditOf(6).detail).toMatchObject({ deletedMatchIds: ['m1'], deletedMatchCount: 1 });
    expect(result.deletedMatchCount).toBe(1);
  });

  test('없는 대회면 404이고 아무것도 쓰지 않는다', async () => {
    queue = [[]];
    await expectStatus(
      service.remove(GUILD, COMPETITION, NAME, ACTOR),
      404,
      'competition-not-found',
    );

    expect(statements).toEqual([]);
    expect(written).toEqual([]);
  });

  test('이름 대조는 FOR UPDATE로 잡은 뒤에 한다', async () => {
    queue = [competitionRow('CLOSED'), []];
    await service.remove(GUILD, COMPETITION, NAME, ACTOR);

    expect(locks).toEqual(['update']);
  });
});
