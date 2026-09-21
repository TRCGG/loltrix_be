import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

let selected: unknown;
let whereCondition: unknown;
let rows: unknown[] = [];

const builder: Record<string, unknown> = {};
builder.from = () => builder;
builder.where = (condition: unknown) => {
  whereCondition = condition;
  return builder;
};
builder.limit = () => builder;
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
