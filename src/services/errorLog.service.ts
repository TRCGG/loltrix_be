import { Request } from 'express';
import { nanoid } from 'nanoid';
import { db } from '../database/connectionPool.js';
import { errorLog } from '../database/schema.js';
import { BusinessError, SystemError } from '../types/error.js';

export interface ErrorLogData {
  error: {
    message: string;
    stack?: string;
    name?: string;
    code?: string;
    errorType?: 'business' | 'system' | 'unknown'; // 에러 타입 추가
  };
  request?: {
    method: string;
    url: string;
    originalUrl: string;
    headers?: Record<string, any>;
    body?: any;
    query?: any;
    params?: any;
  };
  userAgent?: string;
  ipAddress?: string;
  userId?: string;
  severity?: 'error' | 'warning' | 'info';
  status?: number;
}

/**
 * @desc 고유한 에러 코드 생성 (ERR-YYMMDD-xxxxxx 형식)
 * - nanoid 6자리 사용으로 충돌 방지
 */
const generateErrorCode = (): string => {
  const today = new Date();
  const year = today.getFullYear().toString().slice(-2);
  const month = (today.getMonth() + 1).toString().padStart(2, '0');
  const day = today.getDate().toString().padStart(2, '0');

  const dateStr = `${year}${month}${day}`;
  const uniqueId = nanoid(6);

  return `ERR-${dateStr}-${uniqueId}`;
};

/**
 * @desc Request 객체에서 로깅용 데이터 추출
 */
export const extractRequestData = (req: Request) => ({
  method: req.method,
  url: req.url,
  originalUrl: req.originalUrl,
  headers: {
    'user-agent': req.get('user-agent'),
    'content-type': req.get('content-type'),
    'accept': req.get('accept'),
    'authorization': req.get('authorization') ? '[HIDDEN]' : undefined,
  },
  body: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
  query: req.query && Object.keys(req.query).length > 0 ? req.query : undefined,
  params: req.params && Object.keys(req.params).length > 0 ? req.params : undefined,
});

/**
 * @desc 에러를 데이터베이스에 로깅하고 추적 코드 반환
 */
export const logError = async (errorData: ErrorLogData): Promise<string> => {
  const errorCode = generateErrorCode();

  await db.insert(errorLog).values({
    errorCode,
    error: errorData.error,
    request: errorData.request,
    userAgent: errorData.userAgent,
    ipAddress: errorData.ipAddress,
    userId: errorData.userId,
    severity: errorData.severity || 'error',
    status: errorData.status || 500,
  });

  return errorCode;
};


/**
 * @desc Express Request와 Error로부터 에러 로깅 수행
 */
export const logErrorFromRequest = async (
  error: Error,
  req: Request,
  status?: number
): Promise<string> => {
  const requestData = extractRequestData(req);

  // 에러 타입 판별
  let errorType: 'business' | 'system' | 'unknown' = 'unknown';
  if (error instanceof BusinessError) {
    errorType = 'business';
  } else if (error instanceof SystemError) {
    errorType = 'system';
  }

  // IP 주소 추출
  const ipAddress = req.ip ||
    req.socket.remoteAddress ||
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();

  const errorData: ErrorLogData = {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: (error as any).code,
      errorType, // 에러 타입 추가
    },
    request: requestData,
    userAgent: req.get('user-agent'),
    ipAddress,
    userId: (req as any).user?.id, // 사용자 인증 정보가 있다면
    severity: status && status < 500 ? 'warning' : 'error',
    status: status || 500,
  };

  return await logError(errorData);
};