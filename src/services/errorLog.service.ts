import { Request } from 'express';
import { db } from '../database/connectionPool.js';
import { errorLog } from '../database/schema.js';
import { desc, like } from 'drizzle-orm';

export interface ErrorLogData {
  error: {
    message: string;
    stack?: string;
    name?: string;
    code?: string;
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
 * @desc 고유한 에러 코드 생성 (ERR-YYYYMMDD-XXX 형식)
 */
const generateErrorCode = async (): Promise<string> => {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const prefix = `ERR-${today}-`;

  // 오늘 생성된 에러 로그 중 가장 높은 번호 조회
  const lastError = await db
    .select({ errorCode: errorLog.errorCode })
    .from(errorLog)
    .where(like(errorLog.errorCode, `${prefix}%`))
    .orderBy(desc(errorLog.errorCode))
    .limit(1);

  let sequenceNumber = 1;

  if (lastError.length > 0) {
    const lastSequence = lastError[0].errorCode.split('-')[2];
    sequenceNumber = parseInt(lastSequence, 10) + 1;
  }

  return `${prefix}${sequenceNumber.toString().padStart(3, '0')}`;
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
  const errorCode = await generateErrorCode();

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

  // IP 주소 추출
  const ipAddress = req.ip ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim();

  const errorData: ErrorLogData = {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: (error as any).code,
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