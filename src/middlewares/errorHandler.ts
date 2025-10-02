import { Request, Response, NextFunction } from 'express';
import { ProblemDetails, BusinessError, SystemError } from '../types/error.js';
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
    // 에러 타입 판별
    const isBusinessError = err instanceof BusinessError;
    const isSystemError = err instanceof SystemError;
    const showMessage = isBusinessError && err.showMessage;
    const isLoggable = (isBusinessError || isSystemError) ? err.isLoggable : true;

    // 기본 에러 속성
    const status = err.status || 500;
    const title = err.title || 'Internal Server Error';
    const type = err.type || (status >= 400 && status < 500 ? 'client-error' : 'server-error');

    // 에러를 데이터베이스에 로깅하고 추적 코드 받기 (로깅이 필요한 경우에만)
    let errorTrackingCode: string | null = null;
    if (isLoggable) {
      errorTrackingCode = await logErrorFromRequest(
        err instanceof Error ? err : new Error(err.message || 'Unknown error'),
        req,
        status
      );
    }

    // 응답 생성
    const problem: ProblemDetails = {
      type,
      title,
      status
    };

    // 비즈니스 에러인 경우 메시지 노출, 시스템 에러인 경우 에러코드만 노출
    if (showMessage) {
      // 비즈니스 에러: 메시지 노출 + 에러코드 포함 (로깅된 경우)
      problem.detail = errorTrackingCode
        ? `${err.message} (오류 추적 번호: ${errorTrackingCode})`
        : err.message;
    } else {
      // 시스템 에러: 에러코드만 노출
      problem.detail = errorTrackingCode
        ? `오류가 발생했습니다. 오류 추적 번호: ${errorTrackingCode}`
        : '오류가 발생했습니다.';
    }

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
      detail: '오류가 발생했습니다.'
    });
  }
};
