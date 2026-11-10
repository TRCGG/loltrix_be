import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import express, { NextFunction, Request, Response } from 'express';
import { once } from 'node:events';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { AuthRequest } from '../middlewares/authHandler.js';
import { BusinessError } from '../types/error.js';
import {
  POST_CONTENT_MAX,
  POST_TITLE_MAX,
  PostCreateInput,
  PostListQuery,
  PostUpdateInput,
} from '../types/post.js';

const listPublished = jest.fn<(query: PostListQuery) => Promise<unknown>>();
const listForAdmin = jest.fn<(query: PostListQuery) => Promise<unknown>>();
const getPublished = jest.fn<(id: number) => Promise<unknown>>();
const getForAdmin = jest.fn<(id: number) => Promise<unknown>>();
const create = jest.fn<(input: PostCreateInput, authorId: string) => Promise<unknown>>();
const update = jest.fn<(id: number, input: PostUpdateInput) => Promise<unknown>>();
const remove = jest.fn<(id: number) => Promise<boolean>>();
const getActiveRoles = jest.fn<(memberId: string) => Promise<{ role: string }[]>>();

jest.unstable_mockModule('../services/post.service.js', () => ({
  postService: { listPublished, listForAdmin, getPublished, getForAdmin, create, update, remove },
}));
jest.unstable_mockModule('../services/discordMemberRole.service.js', () => ({
  discordMemberRoleService: { getActiveRoles },
}));
jest.unstable_mockModule('../services/guild.service.js', () => ({ guildService: {} }));

const { default: postRoutes } = await import('../routes/post.routes.js');
const { default: adminPostRoutes } = await import('../routes/adminPost.routes.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: AuthRequest, _res, next) => {
    req.discordMemberId = req.get('x-test-member');
    req.isBot = req.get('x-test-bot') === '1';
    next();
  });
  app.use('/api/posts', postRoutes);
  app.use('/api/admin/posts', adminPostRoutes);
  // Express는 인자 네 개로 오류 처리 미들웨어를 구분한다.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: BusinessError, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.status ?? 500).json({ message: error.message });
  });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  [listPublished, listForAdmin, getPublished, getForAdmin, create, update, remove].forEach((fn) =>
    fn.mockReset(),
  );
  getActiveRoles.mockReset().mockResolvedValue([{ role: 'adminNormal' }]);
});

const send = (method: string, path: string, body?: unknown, member: string | null = 'admin-1') =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(member ? { 'x-test-member': member } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const validPost = { category: 'faq', title: '리플 업로드가 안 돼요', content: '## 답변' };

describe('공개 조회 API', () => {
  test('목록은 쿼리를 숫자로 바꿔 넘기고 페이지 정보를 헤더로 준다', async () => {
    listPublished.mockResolvedValue({ items: [{ id: 1 }], totalCount: 11 });

    const res = await send('GET', '/posts?category=faq&page=2&limit=5', undefined, null);

    expect(res.status).toBe(200);
    expect(listPublished).toHaveBeenCalledWith({ category: 'faq', page: 2, limit: 5 });
    expect(res.headers.get('x-total-count')).toBe('11');
    expect(res.headers.get('x-total-pages')).toBe('3');
    expect(await res.json()).toMatchObject({ status: 'success', data: [{ id: 1 }] });
  });

  test('page·limit을 생략하면 1페이지 20개', async () => {
    listPublished.mockResolvedValue({ items: [], totalCount: 0 });

    await send('GET', '/posts', undefined, null);

    expect(listPublished).toHaveBeenCalledWith({ category: undefined, page: 1, limit: 20 });
  });

  test.each(['category=notice', 'limit=101', 'page=0', 'page=abc'])(
    '잘못된 쿼리는 400: %s',
    async (qs) => {
      const res = await send('GET', `/posts?${qs}`, undefined, null);

      expect(res.status).toBe(400);
      expect(listPublished).not.toHaveBeenCalled();
    },
  );

  test.each(['abc', '0', '1.5'])('잘못된 글 id는 400: %s', async (id) => {
    const res = await send('GET', `/posts/${id}`, undefined, null);

    expect(res.status).toBe(400);
    expect(getPublished).not.toHaveBeenCalled();
  });

  test('공개되지 않았거나 없는 글은 404', async () => {
    getPublished.mockResolvedValue(null);

    const res = await send('GET', '/posts/9', undefined, null);

    expect(res.status).toBe(404);
    expect(getPublished).toHaveBeenCalledWith(9);
    expect(await res.json()).toEqual({ status: 'error', message: 'Post not found', data: null });
  });

  test('관리 권한 조회 없이 응답한다', async () => {
    getPublished.mockResolvedValue({ id: 9 });

    const res = await send('GET', '/posts/9', undefined, null);

    expect(res.status).toBe(200);
    expect(getActiveRoles).not.toHaveBeenCalled();
  });
});

describe('관리 API 권한', () => {
  test('세션이 없으면 401', async () => {
    const res = await send('GET', '/admin/posts', undefined, null);

    expect(res.status).toBe(401);
    expect(listForAdmin).not.toHaveBeenCalled();
  });

  test.each(['userNormal', 'guildManager'])('%s는 403', async (role) => {
    getActiveRoles.mockResolvedValue([{ role }]);

    const res = await send('POST', '/admin/posts', validPost);

    expect(res.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('관리 API', () => {
  test.each([
    ['GET', '/admin/posts', undefined],
    ['POST', '/admin/posts', validPost],
    ['PATCH', '/admin/posts/4', { title: 't' }],
    ['DELETE', '/admin/posts/4', undefined],
  ])('봇 요청은 관리 API 전체에서 403: %s %s', async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-bot': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      status: 'error',
      message: 'Bot cannot manage posts',
      data: null,
    });
    [listForAdmin, create, update, remove].forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test('작성은 201, 작성자는 세션 멤버', async () => {
    create.mockResolvedValue({ id: 1 });

    const res = await send('POST', '/admin/posts', {
      ...validPost,
      title: '  제목  ',
      sortOrder: 3,
    });

    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      { category: 'faq', title: '제목', content: '## 답변', sortOrder: 3 },
      'admin-1',
    );
  });

  // 테스트 앱도 src/index.ts처럼 기본 express.json()(100kb)이라, 상한을 올리면 여기서 413으로 드러난다.
  test('최대 길이 한글 제목·본문도 기본 body 제한 안에 들어온다', async () => {
    create.mockResolvedValue({ id: 1 });

    const res = await send('POST', '/admin/posts', {
      ...validPost,
      title: '가'.repeat(POST_TITLE_MAX),
      content: '가'.repeat(POST_CONTENT_MAX),
    });

    expect(res.status).toBe(201);
  });

  test.each([
    ['카테고리 누락', { title: 't', content: 'c' }],
    ['없는 카테고리', { ...validPost, category: 'notice' }],
    ['공백 제목', { ...validPost, title: '   ' }],
    ['공백 본문', { ...validPost, content: ' \n ' }],
    ['제목 200자 초과', { ...validPost, title: 'a'.repeat(201) }],
    ['본문 10,000자 초과', { ...validPost, content: 'a'.repeat(10_001) }],
    ['음수 정렬값', { ...validPost, sortOrder: -1 }],
  ])('작성 검증 실패는 400: %s', async (_label, body) => {
    const res = await send('POST', '/admin/posts', body);

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  test('수정은 보낸 필드만 넘긴다', async () => {
    update.mockResolvedValue({ id: 4 });

    const res = await send('PATCH', '/admin/posts/4', { isPublished: true, sortOrder: null });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(4, { isPublished: true, sortOrder: null });
  });

  test('빈 수정 요청은 400', async () => {
    const res = await send('PATCH', '/admin/posts/4', {});

    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  test('없거나 삭제된 글 수정은 404', async () => {
    update.mockResolvedValue(null);

    const res = await send('PATCH', '/admin/posts/4', { title: '새 제목' });

    expect(res.status).toBe(404);
  });

  test('삭제는 200 + id, 이미 삭제됐으면 404', async () => {
    remove.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const ok = await send('DELETE', '/admin/posts/4');
    const again = await send('DELETE', '/admin/posts/4');

    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ data: { id: 4 } });
    expect(again.status).toBe(404);
  });

  test('관리 목록은 초안 포함 조회를 쓴다', async () => {
    listForAdmin.mockResolvedValue({ items: [], totalCount: 0 });

    const res = await send('GET', '/admin/posts?category=devlog');

    expect(res.status).toBe(200);
    expect(listForAdmin).toHaveBeenCalledWith({ category: 'devlog', page: 1, limit: 20 });
    expect(listPublished).not.toHaveBeenCalled();
  });
});
