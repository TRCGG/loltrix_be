import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { asc, eq } from 'drizzle-orm';
import { champion } from '../database/schema.js';

/** competitionPlayer.service.test와 같은 방식 — await 순서대로 큐에서 하나씩 꺼낸다. */
let queue: unknown[] = [];
let selects: unknown[] = [];
let wheres: unknown[] = [];
let orders: unknown[] = [];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  builder.from = () => builder;
  builder.where = (condition: unknown) => {
    wheres.push(condition);
    return builder;
  };
  builder.orderBy = (...columns: unknown[]) => {
    orders.push(columns);
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
  select: (fields: unknown) => {
    selects.push(fields);
    return makeBuilder();
  },
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));

const { ChampionService } = await import('../services/champion.service.js');

const service = new ChampionService();

const rows = [
  { id: 'CHN_1', champName: '아트록스', champNameEng: 'Aatrox', riotKey: 266 },
  { id: 'CHN_2', champName: '아리', champNameEng: 'Ahri', riotKey: null },
];

beforeEach(() => {
  queue = [];
  selects = [];
  wheres = [];
  orders = [];
});

describe('ChampionService.getAll', () => {
  test('조회한 행을 순서 그대로 반환한다', async () => {
    queue = [rows];

    expect(await service.getAll()).toEqual(rows);
  });

  test('id·한글명·영문명·riotKey만 선택한다', async () => {
    queue = [rows];
    await service.getAll();

    expect(Object.keys(selects[0] as object)).toEqual([
      'id',
      'champName',
      'champNameEng',
      'riotKey',
    ]);
  });

  test('삭제된 챔피언은 제외한다', async () => {
    queue = [rows];
    await service.getAll();

    expect(wheres).toEqual([eq(champion.isDeleted, false)]);
  });

  test('한글명 오름차순, 동일하면 id 오름차순으로 정렬한다', async () => {
    queue = [rows];
    await service.getAll();

    expect(orders).toEqual([[asc(champion.champName), asc(champion.id)]]);
  });

  test('행이 없으면 빈 배열', async () => {
    queue = [[]];

    expect(await service.getAll()).toEqual([]);
  });
});
