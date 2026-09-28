import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

let selected: unknown;
let whereCondition: unknown;
let rows: unknown[] = [];
let conditions: unknown[] = [];
let rowLimit: unknown;
let rowOffset: unknown;

const builder: Record<string, unknown> = {};
builder.from = () => builder;
builder.where = (condition: unknown) => {
  whereCondition = condition;
  conditions.push(condition);
  return builder;
};
builder.limit = (value: unknown) => {
  rowLimit = value;
  return builder;
};
builder.offset = (value: unknown) => {
  rowOffset = value;
  return builder;
};
builder.orderBy = () => builder;
builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: {
    select: (fields: unknown) => {
      selected = fields;
      return builder;
    },
  },
}));

const { GuildService } = await import('../services/guild.service.js');
const { guild } = await import('../database/schema.js');

const service = new GuildService();
const dialect = new PgDialect();

beforeEach(() => {
  selected = undefined;
  whereCondition = undefined;
  rows = [];
  conditions = [];
  rowLimit = undefined;
  rowOffset = undefined;
});

describe('길드 공개 판정', () => {
  test('id가 같고 공개이며 삭제되지 않은 길드만 최소 projection으로 확인한다', async () => {
    rows = [{ id: 'guild-1' }];

    await expect(service.isPublicGuild('guild-1')).resolves.toBe(true);

    expect(Object.keys(selected as Record<string, unknown>)).toEqual(['id']);
    const query = dialect.sqlToQuery(whereCondition as SQL);
    expect(query.sql).toContain('"guild"."id" = $1');
    expect(query.sql).toContain('"guild"."is_public" = $2');
    expect(query.sql).toContain('"guild"."is_deleted" = $3');
    expect(query.params).toEqual(['guild-1', true, false]);
  });

  test('일치 행이 없으면 공개하지 않는다', async () => {
    await expect(service.isPublicGuild('private-or-deleted')).resolves.toBe(false);
  });

  test('스키마 기본값은 기존·신규 길드를 비공개로 유지한다', () => {
    expect(guild.isPublic.notNull).toBe(true);
    expect(guild.isPublic.hasDefault).toBe(true);
    expect(guild.isPublic.default).toBe(false);
  });
});

describe('Guild list filters', () => {
  test.each([undefined, 'Public'])(
    'rows and count share non-deleted filtering without public filtering and search %s',
    async (search) => {
      await service.findAllGuilds({ page: 2, limit: 3, search });
      expect(conditions).toHaveLength(2);
      const queries = conditions.map((condition) => dialect.sqlToQuery(condition as SQL));
      expect(queries[0]).toEqual(queries[1]);
      expect(queries[0].sql).toContain('"guild"."is_deleted" = $1');
      expect(queries[0].sql).not.toContain('is_public');
      expect(queries[0].params).toEqual(search ? [false, '%Public%'] : [false]);
      if (search) expect(queries[0].sql).toContain('"guild"."name" ilike $2');
      expect(rowLimit).toBe(3);
      expect(rowOffset).toBe(3);
    },
  );
  test('internal callers retain private guilds and larger limits', async () => {
    await service.findAllGuilds({ limit: 1000 });
    const query = dialect.sqlToQuery(conditions[0] as SQL);
    expect(query.sql).not.toContain('is_public');
    expect(query.params).toEqual([false]);
    expect(rowLimit).toBe(1000);
  });
});
