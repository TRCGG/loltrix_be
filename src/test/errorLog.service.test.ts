import { Request } from 'express';
import {
  logError,
  logErrorFromRequest,
  extractRequestData,
  ErrorLogData
} from '../services/errorLog.service.js';
import { db } from '../database/connectionPool.js';
import { errorLog } from '../database/schema.js';

// Mock database
jest.mock('../database/connectionPool.js');
const mockDb = db as jest.Mocked<typeof db>;

describe('Error Log Service Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('extractRequestData', () => {
    test('should extract request data correctly', () => {
      const req = {
        method: 'POST',
        url: '/api/test',
        originalUrl: '/api/test?param=value',
        get: jest.fn((header) => {
          switch (header) {
            case 'user-agent': return 'Mozilla/5.0';
            case 'content-type': return 'application/json';
            case 'authorization': return 'Bearer token';
            default: return undefined;
          }
        }),
        body: { name: 'test' },
        query: { param: 'value' },
        params: { id: '123' }
      } as Partial<Request> as Request;

      const result = extractRequestData(req);

      expect(result).toEqual({
        method: 'POST',
        url: '/api/test',
        originalUrl: '/api/test?param=value',
        headers: {
          'user-agent': 'Mozilla/5.0',
          'content-type': 'application/json',
          'accept': undefined,
          'authorization': '[HIDDEN]'
        },
        body: { name: 'test' },
        query: { param: 'value' },
        params: { id: '123' }
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
        params: {}
      } as Partial<Request> as Request;

      const result = extractRequestData(req);

      expect(result.body).toBeUndefined();
      expect(result.query).toBeUndefined();
      expect(result.params).toBeUndefined();
    });
  });

  describe('logError', () => {
    test('should log error and return tracking code', async () => {
      // Mock generateErrorCode
      const mockSelect = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };

      const mockInsert = {
        values: jest.fn().mockResolvedValue([{ errorCode: 'ERR-20250925-001' }])
      };

      mockDb.select = jest.fn().mockReturnValue(mockSelect);
      mockDb.insert = jest.fn().mockReturnValue(mockInsert);

      const errorData: ErrorLogData = {
        error: {
          message: 'Test error',
          stack: 'Error stack',
          name: 'Error'
        },
        severity: 'error',
        status: 500
      };

      const result = await logError(errorData);

      expect(result).toMatch(/^ERR-\d{8}-\d{3}$/);
      expect(mockDb.insert).toHaveBeenCalledWith(errorLog);
      expect(mockInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCode: expect.any(String),
          error: errorData.error,
          severity: 'error',
          status: 500
        })
      );
    });
  });

  describe('logErrorFromRequest', () => {
    test('should log error from Express request', async () => {
      const mockSelect = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };

      const mockInsert = {
        values: jest.fn().mockResolvedValue([])
      };

      mockDb.select = jest.fn().mockReturnValue(mockSelect);
      mockDb.insert = jest.fn().mockReturnValue(mockInsert);

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
        connection: { remoteAddress: '127.0.0.1' }
      } as Partial<Request> as Request;

      const result = await logErrorFromRequest(error, req, 500);

      expect(result).toMatch(/^ERR-\d{8}-\d{3}$/);
      expect(mockInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: 'Test error',
            stack: expect.any(String),
            name: 'Error'
          }),
          request: expect.objectContaining({
            method: 'POST',
            url: '/api/test'
          }),
          userAgent: 'Mozilla/5.0',
          ipAddress: '127.0.0.1',
          severity: 'error',
          status: 500
        })
      );
    });

    test('should classify 4xx errors as warnings', async () => {
      const mockSelect = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([])
      };

      const mockInsert = {
        values: jest.fn().mockResolvedValue([])
      };

      mockDb.select = jest.fn().mockReturnValue(mockSelect);
      mockDb.insert = jest.fn().mockReturnValue(mockInsert);

      const error = new Error('Client error');
      const req = {
        method: 'GET',
        url: '/api/test',
        originalUrl: '/api/test',
        get: jest.fn(),
        body: {},
        query: {},
        params: {},
        ip: '127.0.0.1'
      } as Partial<Request> as Request;

      await logErrorFromRequest(error, req, 400);

      expect(mockInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'warning',
          status: 400
        })
      );
    });
  });

});

export {};