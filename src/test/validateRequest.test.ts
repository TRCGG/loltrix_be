import { jest, describe, test, expect } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';

type ReqParts = {
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
};

const makeReq = ({ body = {}, query = {}, params = {} }: ReqParts = {}) =>
  ({ body, query, params, originalUrl: '/api/test' }) as unknown as Request;

const makeRes = () => {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
  };
  return res;
};

const run = async (schema: Parameters<typeof validateRequest>[0], req: Request) => {
  const res = makeRes();
  const next = jest.fn();
  await validateRequest(schema)(req, res as unknown as Response, next as NextFunction);
  return { res, next };
};

describe('validateRequest — 파싱 결과 반영', () => {
  test('query의 transform 결과가 컨트롤러에 전달된다', async () => {
    const schema = z.object({
      query: z.object({
        page: z.string().regex(/^\d+$/).transform(Number).optional(),
      }),
    });
    const req = makeReq({ query: { page: '3' } });

    const { next } = await run(schema, req);

    expect(next).toHaveBeenCalledWith();
    expect(req.query.page).toBe(3);
  });

  test('default가 적용된다', async () => {
    const schema = z.object({
      query: z.object({ status: z.enum(['1', '2', 'all']).optional().default('1') }),
      body: z.object({ gameType: z.enum(['1', '2', '3']).default('1') }),
    });
    const req = makeReq({ body: {} });

    await run(schema, req);

    expect(req.query.status).toBe('1');
    expect((req.body as { gameType: string }).gameType).toBe('1');
  });

  test('스키마가 선언하지 않은 키는 버려진다 — 컨트롤러가 읽는 키는 전부 선언해야 한다', async () => {
    const schema = z.object({ query: z.object({ page: z.string().optional() }) });
    const req = makeReq({ query: { page: '1', season: 'S13' } });

    await run(schema, req);

    expect(req.query).toEqual({ page: '1' });
  });

  test('passthrough를 쓰면 선언하지 않은 키도 남는다', async () => {
    const schema = z.object({
      query: z.object({ page: z.string().optional() }).passthrough(),
    });
    const req = makeReq({ query: { page: '1', season: 'S13' } });

    await run(schema, req);

    expect(req.query).toEqual({ page: '1', season: 'S13' });
  });

  test('스키마에 없는 자리는 원본 그대로 둔다', async () => {
    const schema = z.object({ query: z.object({ page: z.string().optional() }) });
    const params = { guildId: '123', riotName: 'me' };
    const req = makeReq({ query: { page: '1' }, params, body: { keep: true } });

    await run(schema, req);

    expect(req.params).toBe(params);
    expect(req.body).toEqual({ keep: true });
  });

  test('decodeGuildId가 바꿔 놓은 params 값이 보존된다', async () => {
    const schema = z.object({ params: z.object({ guildId: z.string().min(1).max(128) }) });
    const req = makeReq({ params: { guildId: '987654321098765432' } });

    await run(schema, req);

    expect(req.params.guildId).toBe('987654321098765432');
  });

  test('ZodError는 400 problem+json으로 응답하고 next를 부르지 않는다', async () => {
    const schema = z.object({
      query: z.object({ page: z.string().regex(/^\d+$/, 'Page must be a positive number') }),
    });
    const req = makeReq({ query: { page: 'abc' } });

    const { res, next } = await run(schema, req);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    expect(res.payload).toMatchObject({
      title: 'Validation Failed',
      status: 400,
      detail: 'The request payload failed validation',
      instance: '/api/test',
      errors: [{ path: 'query.page', message: 'Page must be a positive number' }],
    });
    expect(req.query.page).toBe('abc');
  });
});
