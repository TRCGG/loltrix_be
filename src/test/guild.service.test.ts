import { jest, describe, test, expect, beforeEach } from '@jest/globals';

let insertResult: unknown[] = [];
let selectResult: unknown[] = [];
let selectCalls = 0;

const thenable = (value: () => unknown[]) => ({
  then: (resolve: (v: unknown) => unknown) => Promise.resolve(value()).then(resolve),
});

const executor = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => thenable(() => insertResult) }),
    }),
  }),
  select: () => {
    selectCalls += 1;
    return { from: () => ({ where: () => ({ limit: () => thenable(() => selectResult) }) }) };
  },
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));

const { guildService } = await import('../services/guild.service.js');

const row = (isDeleted: boolean) => ({ id: '1', name: '길드', isDeleted });

describe('guildService.insertGuild', () => {
  beforeEach(() => {
    insertResult = [];
    selectResult = [];
    selectCalls = 0;
  });

  test('새 길드면 삽입한 행을 created로 반환하고 다시 조회하지 않는다', async () => {
    insertResult = [row(false)];

    const result = await guildService.insertGuild({ id: '1', name: '길드' });

    expect(result).toEqual({ guild: row(false), created: true });
    expect(selectCalls).toBe(0);
  });

  test('이미 있으면 삭제된 행이라도 되살리지 않고 그대로 반환한다', async () => {
    selectResult = [row(true)];

    const result = await guildService.insertGuild({ id: '1', name: '길드' });

    expect(result).toEqual({ guild: row(true), created: false });
  });
});
