import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { getTableName } from 'drizzle-orm';
import { PgDialect, PgTable } from 'drizzle-orm/pg-core';

/**
 * competitionTeam.service.test와 같은 결과 큐 방식 — 체인 메서드는 자기 자신을 돌려주고,
 * await 하는 순간 큐에서 하나를 꺼낸다. tx.query.*.findFirst는 큐가 따로 있다.
 */
let queue: unknown[] = [];
let memberQueue: unknown[] = [];
/** update에 넘어간 값 — 차단됐을 때 아무것도 쓰지 않는지 보려고 모은다. */
let written: unknown[] = [];
/** 대회 조회의 조인 대상·조건 — 신청과 로스터를 둘 다 보는지 확인하려고 모은다. */
let joined: unknown[] = [];
let wheres: unknown[] = [];

const CHAIN_METHODS = ['from', 'limit', 'returning', 'orderBy', 'innerJoin'];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.leftJoin = (table: unknown, on: unknown) => {
    joined.push({ table, on });
    return builder;
  };
  builder.where = (condition: unknown) => {
    wheres.push(condition);
    return builder;
  };
  builder.set = (value: unknown) => {
    written.push(value);
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
  select: () => makeBuilder(),
  selectDistinct: () => makeBuilder(),
  insert: () => makeBuilder(),
  update: () => makeBuilder(),
  delete: () => makeBuilder(),
  query: {
    guildMember: {
      findFirst: async () => (memberQueue.length > 0 ? memberQueue.shift() : undefined),
    },
  },
  transaction: async (callback: (tx: unknown) => unknown) => callback(executor),
};

const findAccountByRiotId = jest.fn();

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));
jest.unstable_mockModule('../services/riotAccount.service.js', () => ({
  riotAccountService: { findAccountByRiotId },
}));

const { GuildMemberService } = await import('../services/guildMember.service.js');

const service = new GuildMemberService();
const GUILD = 'guild-1';
const MAIN = { playerCode: 'PLR_000100', riotName: '본캐', riotNameTag: 'KR1' };
const SUB = { playerCode: 'PLR_000200', riotName: '부캐', riotNameTag: 'KR2' };

const linkInput = {
  guildId: GUILD,
  subRiotName: SUB.riotName,
  subRiotTag: SUB.riotNameTag,
  mainRiotName: MAIN.riotName,
  mainRiotTag: MAIN.riotNameTag,
};

const renderWhere = (condition: unknown) =>
  new PgDialect().sqlToQuery(condition as Parameters<PgDialect['sqlToQuery']>[0]);

beforeEach(() => {
  queue = [];
  memberQueue = [
    { id: 12, account: SUB.playerCode, isMain: true },
    { id: 11, account: MAIN.playerCode, isMain: true },
  ];
  written = [];
  joined = [];
  wheres = [];
  findAccountByRiotId.mockImplementation(async (params: unknown) =>
    (params as { riotName: string }).riotName === MAIN.riotName ? MAIN : SUB,
  );
});

describe('대회에 남아 있는 계정은 부계정으로 내리지 않는다', () => {
  test('신청이 남아 있으면 409이고 대회 이름을 알려준다', async () => {
    queue = [[{ name: '멸망전 1회' }, { name: '멸망전 2회' }]];
    await expect(service.linkSubAccount(linkInput)).rejects.toMatchObject({
      status: 409,
      type: 'account-in-competition',
      message:
        'account has an active competition application or roster entry; cancel it first: 멸망전 1회, 멸망전 2회',
    });
    expect(written).toEqual([]);
  });

  test('신청과 로스터를 둘 다 보고, 모집중·진행중만 걸러낸다', async () => {
    queue = [[{ name: '멸망전 1회' }]];
    await expect(service.linkSubAccount(linkInput)).rejects.toMatchObject({
      type: 'account-in-competition',
    });

    const { sql, params } = renderWhere(wheres[0]);
    expect(sql).toContain('"competition_application"."id" is not null');
    expect(sql).toContain('"competition_team_member"."id" is not null');
    expect(params).toEqual(expect.arrayContaining([GUILD, 'RECRUITING', 'IN_PROGRESS']));
    expect(params).not.toContain('CLOSED');

    const joins = (joined as { table: unknown; on: unknown }[]).map(({ table, on }) => ({
      table: getTableName(table as PgTable),
      params: renderWhere(on).params,
    }));
    expect(joins).toEqual([
      { table: 'competition_application', params: [SUB.playerCode, 'REJECTED'] },
      { table: 'competition_team_member', params: [SUB.playerCode] },
    ]);
  });

  test('걸리는 대회가 없으면 연결한다', async () => {
    const linked = { id: 12, account: SUB.playerCode, mainAccount: MAIN.playerCode, isMain: false };
    queue = [[], [linked]];
    await expect(service.linkSubAccount(linkInput)).resolves.toEqual(linked);
    expect(written).toEqual([
      expect.objectContaining({ isMain: false, mainAccount: MAIN.playerCode }),
    ]);
  });

  test('길드에 없는 계정은 대회를 조회하기 전에 걸러진다 (400)', async () => {
    memberQueue = [];
    await expect(service.linkSubAccount(linkInput)).rejects.toMatchObject({ status: 400 });
    expect(wheres).toEqual([]);
  });
});
