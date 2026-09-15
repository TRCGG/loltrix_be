import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { getTableName } from 'drizzle-orm';

/**
 * competition.service.test.ts와 같은 방식 — 체인 메서드는 자기 자신을 돌려주고 await 때 큐에서 꺼낸다.
 */
let queue: unknown[] = [];
let written: unknown[] = [];
/** 실행된 쓰기 문을 `op table` 형태로 */
let statements: string[] = [];

const CHAIN_METHODS = ['from', 'where', 'limit', 'returning', 'orderBy'];

const makeBuilder = (): Record<string, unknown> => {
  const builder: Record<string, unknown> = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = () => builder;
  }
  builder.set = (value: unknown) => {
    written.push(value);
    return builder;
  };
  builder.values = (value: unknown) => {
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

const record = (op: string) => (table: unknown) => {
  statements.push(`${op} ${getTableName(table as Parameters<typeof getTableName>[0])}`);
  return makeBuilder();
};

const executor: Record<string, unknown> = {
  select: () => makeBuilder(),
  insert: record('insert'),
  update: record('update'),
  delete: record('delete'),
  transaction: async (callback: (tx: unknown) => unknown) => callback(executor),
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({ db: executor }));

const { matchParticipantService } = await import('../services/matchParticipant.service.js');

const GAME = 'KR_1234';
const GUILD = 'guild-1';
const ACTOR = { memberId: 'member-1', source: 'bot' as const };

beforeEach(() => {
  queue = [];
  written = [];
  statements = [];
});

describe('경기 삭제(!drop)', () => {
  test('참가자·MMR 지표·리플·팀 귀속까지 한 트랜잭션에서 함께 내린다', async () => {
    queue = [[{ id: GAME, guildId: GUILD }]];
    const result = await matchParticipantService.deleteMatch(GAME, GUILD, ACTOR);

    expect(statements).toEqual([
      'update custom_match',
      'update match_participant',
      'update mmr_participant_metric',
      'update replay',
      'delete competition_match_team',
      'insert guild_audit_log',
    ]);
    expect(written.slice(0, 4)).toEqual(
      Array(4).fill({ isDeleted: true, updateDate: expect.any(Date) }),
    );
    expect(result).toMatchObject({ id: GAME });
  });

  test('삭제 감사 로그를 한 줄 남긴다', async () => {
    queue = [[{ id: GAME, guildId: GUILD }]];
    await matchParticipantService.deleteMatch(GAME, GUILD, ACTOR);

    expect(written[4]).toEqual({
      guildId: GUILD,
      eventType: 'replayDelete',
      actorMemberId: 'member-1',
      detail: { gameId: GAME, source: 'bot' },
    });
  });

  test('없거나 이미 지운 경기면 캐스케이드도 감사 로그도 없이 null', async () => {
    queue = [[]];
    const result = await matchParticipantService.deleteMatch(GAME, GUILD, ACTOR);

    expect(result).toBeNull();
    expect(statements).toEqual(['update custom_match']);
    expect(written).toEqual([{ isDeleted: true, updateDate: expect.any(Date) }]);
  });
});
