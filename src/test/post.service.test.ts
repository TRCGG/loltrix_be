import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

type Call = { op: string; args: Record<string, unknown[]> };

let queue: unknown[] = [];
let calls: Call[] = [];

const CHAIN_METHODS = ['from', 'where', 'orderBy', 'limit', 'offset', 'values', 'set', 'returning'];

const start = (op: string) => (first?: unknown) => {
  const args: Record<string, unknown[]> = { [op]: [first] };
  calls.push({ op, args });
  const builder: Record<string, unknown> = {};
  CHAIN_METHODS.forEach((m) => {
    builder[m] = (...received: unknown[]) => {
      args[m] = received;
      return builder;
    };
  });
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(queue.length > 0 ? queue.shift() : []).then(resolve, reject);
  return builder;
};

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: { select: start('select'), insert: start('insert'), update: start('update') },
}));

const { PostService } = await import('../services/post.service.js');

const service = new PostService();
const dialect = new PgDialect();
const render = (chunk: unknown) => dialect.sqlToQuery(sql`${chunk as SQL}`).sql;

beforeEach(() => {
  queue = [];
  calls = [];
});

describe('PostService 목록', () => {
  test('공개 faq 목록: 본문 포함, 공개 글만, 정렬값 순서, offset 계산', async () => {
    queue = [[{ id: 1 }], [{ count: 7 }]];

    const result = await service.listPublished({ category: 'faq', page: 3, limit: 5 });

    expect(result).toEqual({ items: [{ id: 1 }], totalCount: 7 });
    const [list, count] = calls;
    expect(Object.keys(list.args.select[0] as object)).toEqual(expect.arrayContaining(['content']));
    expect(list.args.select[0]).not.toHaveProperty('isPublished');
    expect(render(list.args.where[0])).toContain('"is_published" = $');
    expect(list.args.orderBy.map(render)).toEqual([
      '"post"."sort_order" ASC NULLS LAST',
      '"post"."id" asc',
    ]);
    expect(list.args.offset).toEqual([10]);
    expect(render(count.args.where[0])).toBe(render(list.args.where[0]));
  });

  test('관리 devlog 목록: 본문 없음, 초안 포함, 초안이 맨 위', async () => {
    queue = [[], [{ count: 0 }]];

    await service.listForAdmin({ category: 'devlog', page: 1, limit: 20 });

    const [list] = calls;
    expect(list.args.select[0]).not.toHaveProperty('content');
    expect(list.args.select[0]).toHaveProperty('isPublished');
    expect(render(list.args.where[0])).not.toContain('is_published');
    expect(list.args.orderBy.map(render)).toEqual([
      '"post"."publish_date" DESC NULLS FIRST',
      '"post"."id" desc',
    ]);
  });

  test('카테고리를 생략하면 전체를 최신순으로, 본문 없이', async () => {
    queue = [[], [{ count: 0 }]];

    await service.listPublished({ page: 1, limit: 20 });

    const [list] = calls;
    expect(list.args.select[0]).not.toHaveProperty('content');
    expect(render(list.args.where[0])).not.toContain('"category"');
    expect(render(list.args.orderBy[0])).toContain('publish_date');
  });
});

describe('PostService 작성·수정', () => {
  const input = { category: 'devlog' as const, title: 't', content: 'c' };

  test('공개로 작성하면 publishDate를 지금으로 찍는다', async () => {
    queue = [[{ id: 1 }]];

    await service.create({ ...input, isPublished: true }, 'admin-1');

    const values = calls[0].args.values[0] as Record<string, unknown>;
    expect(render(values.publishDate)).toBe('NOW()');
    expect(values).toMatchObject({ isPublished: true, authorId: 'admin-1', sortOrder: null });
  });

  test('초안으로 작성하면 publishDate는 NULL', async () => {
    queue = [[{ id: 1 }]];

    await service.create(input, 'admin-1');

    expect(calls[0].args.values[0]).toMatchObject({ isPublished: false, publishDate: null });
  });

  test('공개 전환은 기존 publishDate를 덮지 않는다', async () => {
    queue = [[{ id: 4 }]];

    await service.update(4, { isPublished: true });

    const set = calls[0].args.set[0] as Record<string, unknown>;
    expect(render(set.publishDate)).toBe('COALESCE("post"."publish_date", NOW())');
  });

  test('공개 내림·일반 수정은 publishDate를 건드리지 않는다', async () => {
    queue = [[{ id: 4 }], [{ id: 4 }]];

    await service.update(4, { isPublished: false });
    await service.update(4, { title: '새 제목' });

    expect(calls[0].args.set[0]).toEqual({ isPublished: false });
    expect(calls[1].args.set[0]).toEqual({ title: '새 제목' });
  });

  test('수정·삭제 대상이 없으면 null·false', async () => {
    queue = [[], []];

    expect(await service.update(4, { title: 'x' })).toBeNull();
    expect(await service.remove(4)).toBe(false);
    expect(calls[1].args.set[0]).toEqual({ isDeleted: true });
  });
});

describe('PostService 공개 범위', () => {
  test('공개 상세는 공개·미삭제 글만, 관리 상세는 초안도 조회한다', async () => {
    queue = [[], []];

    await service.getPublished(4);
    await service.getForAdmin(4);

    const [published, admin] = calls.map((call) => render(call.args.where[0]));
    expect(published).toContain('"is_published" = $');
    expect(published).toContain('"is_deleted" = $');
    expect(admin).toContain('"is_deleted" = $');
    expect(admin).not.toContain('is_published');
  });

  test('어떤 응답에도 authorId를 담지 않는다', async () => {
    queue = [[], [{ count: 0 }], [], [], [{ id: 1 }], [{ id: 1 }]];

    await service.listForAdmin({ category: 'faq', page: 1, limit: 20 });
    await service.getPublished(1);
    await service.getForAdmin(1);
    await service.create({ category: 'faq', title: 't', content: 'c' }, 'admin-1');
    await service.update(1, { title: 't' });

    const returnedFields = calls.map((call) => call.args.returning?.[0] ?? call.args.select[0]);
    returnedFields.forEach((fields) => expect(fields).not.toHaveProperty('authorId'));
  });

  test('관리 faq 목록도 본문을 담는다', async () => {
    queue = [[], [{ count: 0 }]];

    await service.listForAdmin({ category: 'faq', page: 1, limit: 20 });

    expect(calls[0].args.select[0]).toHaveProperty('content');
  });

  test('삭제는 이미 삭제된 글을 대상에서 뺀다', async () => {
    queue = [[]];

    await service.remove(4);

    expect(render(calls[0].args.where[0])).toContain('"is_deleted" = $');
  });
});
