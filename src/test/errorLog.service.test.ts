import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import type { Request } from 'express';

// 소스가 ESM 이라 jest.mock 호이스팅이 동작하지 않는다.
// unstable_mockModule 로 등록한 뒤 대상 모듈을 동적 import 해야 목이 적용된다.
type AsyncFn = (...args: any[]) => Promise<any>;

const values = jest.fn<AsyncFn>();
const insert = jest.fn<(table: unknown) => { values: typeof values }>(() => ({ values }));

jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: { insert },
}));

const { logError, logErrorFromRequest, extractRequestData } = await import(
  '../services/errorLog.service.js'
);
const { errorLog } = await import('../database/schema.js');

type ErrorLogData = Parameters<typeof logError>[0];

// ERR-YYMMDD-<nanoid 6자> — nanoid 기본 알파벳은 A-Za-z0-9_-
const ERROR_CODE_PATTERN = /^ERR-\d{6}-[\w-]{6}$/;

describe('Error Log Service Tests', () => {
  beforeEach(() => {
    values.mockResolvedValue([]);
  });

  describe('extractRequestData', () => {
    test('should extract request data correctly', () => {
      const req = {
        method: 'POST',
        url: '/api/test',
        originalUrl: '/api/test?param=value',
        get: jest.fn((header: string) => {
          switch (header) {
            case 'user-agent':
              return 'Mozilla/5.0';
            case 'content-type':
              return 'application/json';
            case 'authorization':
              return 'Bearer token';
            default:
              return undefined;
          }
        }),
        body: { name: 'test' },
        query: { param: 'value' },
        params: { id: '123' },
      } as Partial<Request> as Request;

      const result = extractRequestData(req);

      expect(result).toEqual({
        method: 'POST',
        url: '/api/test',
        originalUrl: '/api/test?param=value',
        headers: {
          'user-agent': 'Mozilla/5.0',
          'content-type': 'application/json',
          accept: undefined,
          authorization: '[HIDDEN]',
        },
        body: { name: 'test' },
        query: { param: 'value' },
        params: { id: '123' },
      });
    });

    test('should handle empty request data', () => {
      const req = {
        method: 'GET',
        url: '/api/test',
        originalUrl: '/api/test',
        get: jest.fn().mockReturnValue(undefined),
        body: {},
        query: {},
        params: {},
      } as Partial<Request> as Request;

      const result = extractRequestData(req);

      expect(result?.body).toBeUndefined();
      expect(result?.query).toBeUndefined();
      expect(result?.params).toBeUndefined();
    });
  });

  describe('logError', () => {
    test('should log error and return tracking code', async () => {
      const errorData: ErrorLogData = {
        error: {
          message: 'Test error',
          stack: 'Error stack',
          name: 'Error',
        },
        severity: 'error',
        status: 500,
      };

      const result = await logError(errorData);

      expect(result).toMatch(ERROR_CODE_PATTERN);
      expect(insert).toHaveBeenCalledWith(errorLog);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: expect.any(String),
          error: errorData.error,
          severity: 'error',
          status: 500,
        }),
      );
    });
  });

  // 이 함수가 reject하면 컨트롤러 catch 안에서 unhandledRejection이 되어
  // 응답을 못 내보낸 채 프로세스가 죽는다. 절대 던지지 않는지 고정한다.
  describe('logError - DB 기록 실패 시 폴백', () => {
    test('throw하지 않고 null을 반환한다', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      values.mockRejectedValue(
        Object.assign(new Error('Failed query: insert into error_log ...'), {
          cause: { code: '22P05' },
        }),
      );

      await expect(logError({ error: { message: 'BOOM' }, status: 500 })).resolves.toBeNull();

      consoleError.mockRestore();
    });

    test('원본 에러와 SQLSTATE를 stderr에 남긴다', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      values.mockRejectedValue(
        Object.assign(new Error('Failed query: insert into error_log ...'), {
          cause: { code: '22P05' },
        }),
      );

      await logError({ error: { message: 'BOOM' }, status: 500 });

      const logged = consoleError.mock.calls[0].map(String).join(' ');
      expect(logged).toContain('[error_log FALLBACK]');
      expect(logged).toContain('BOOM'); // 원본 에러가 유실되지 않는다
      expect(logged).toContain('22P05'); // 원인 특정에 필요한 SQLSTATE

      consoleError.mockRestore();
    });

    test('logErrorFromRequest도 동일하게 null을 반환한다', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      values.mockRejectedValue(new Error('insert failed'));

      const req = {
        method: 'GET',
        url: '/api/auth/guilds',
        originalUrl: '/api/auth/guilds',
        get: jest.fn(),
        body: {},
        query: {},
        params: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as unknown as Request;

      await expect(logErrorFromRequest(new Error('controller error'), req, 500)).resolves.toBeNull();

      consoleError.mockRestore();
    });
  });

  describe('logErrorFromRequest', () => {
    test('should log error from Express request', async () => {
      const error = new Error('Test error');
      const req = {
        method: 'POST',
        url: '/api/test',
        originalUrl: '/api/test',
        get: jest.fn().mockReturnValue('Mozilla/5.0'),
        body: { test: 'data' },
        query: {},
        params: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as unknown as Request;

      const result = await logErrorFromRequest(error, req, 500);

      expect(result).toMatch(ERROR_CODE_PATTERN);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Test error',
            stack: expect.any(String),
            name: 'Error',
          }),
          request: expect.objectContaining({
            method: 'POST',
            url: '/api/test',
          }),
          userAgent: 'Mozilla/5.0',
          ipAddress: '127.0.0.1',
          severity: 'error',
          status: 500,
        }),
      );
    });

    test('should classify 4xx errors as warnings', async () => {
      const error = new Error('Client error');
      const req = {
        method: 'GET',
        url: '/api/test',
        originalUrl: '/api/test',
        get: jest.fn(),
        body: {},
        query: {},
        params: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        headers: {},
      } as unknown as Request;

      await logErrorFromRequest(error, req, 400);

      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'warning',
          status: 400,
        }),
      );
    });
  });
});

export {};
