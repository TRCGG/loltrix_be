import { Request, Response, NextFunction } from 'express';
import { ProblemDetails } from '../types/error.js';
import { logErrorFromRequest } from '../services/errorLog.service.js';

export const errorHandler = async (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // 응답이 이미 전송된 경우 기본 오류 처리기에 위임
  if (res.headersSent) {
    return next(err);
  }

  try {
    // 기본 에러 속성
    const status = err.status || 500;
    const title = err.title || 'Internal Server Error';
    const detail = err.detail || 'An unexpected error occurred';
    const type = err.type || (status >= 400 && status < 500 ? 'client-error' : 'server-error');

    // 에러를 데이터베이스에 로깅하고 추적 코드 받기
    const errorTrackingCode = await logErrorFromRequest(
      err instanceof Error ? err : new Error(err.message || 'Unknown error'),
      req,
      status
    );

    // 간단한 응답 생성
    const problem: ProblemDetails = {
      type,
      title,
      status,
      detail: `${detail} (오류 추적 번호: ${errorTrackingCode})`,
      instance: req.originalUrl
    };

    // 개발 환경에서만 스택 트레이스 포함
    if (process.env.NODE_ENV === 'development' && err.stack) {
      problem.errors = [{
        code: 'stack_trace',
        value: err.stack,
        message: 'Stack trace (development only)'
      }];
      console.error(problem);
    }

    res.status(status).json(problem);
  } catch (loggingError) {
    // 로깅 실패 시 최소한의 응답
    console.error('Error logging failed:', loggingError);

    res.status(500).json({
      type: 'server-error',
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred and could not be logged properly',
      instance: req.originalUrl,
    });
  }
};
