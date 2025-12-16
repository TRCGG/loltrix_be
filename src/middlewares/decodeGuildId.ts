import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../types/error.js';

/**
 * Base64 문자열을 디코딩하는 헬퍼 함수
 * @param encodedString 인코딩된 문자열
 * @returns 디코딩된 문자열
 * @throws 에러 발생 시 'Invalid Base64 string'
 */
const decodeBase64 = (encodedString: string): string => {
  try {
    return Buffer.from(encodedString, 'base64').toString('utf8');
  } catch (error) {
    throw new Error('Invalid Base64 string');
  }
};

/**
 * req 객체의 다양한 위치에서 guild ID를 찾아 Base64 디코딩하는 Express 미들웨어
 */
export const decodeGuildIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. req.params (라우트 파라미터, 예: /guilds/:guildId)
    if (req.params.guildId) {
      req.params.guildId = decodeBase64(req.params.guildId);
    }

    // 2. req.query (쿼리 스트링, 예: /guilds?guildId=...)
    if (req.query.guildId && typeof req.query.guildId === 'string') {
      req.query.guildId = decodeBase64(req.query.guildId);
    }
    
    next();
  } catch (error) {
    throw new BusinessError('Invalid Base64 encoded guildId provided', 400);
  }
};