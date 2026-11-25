import { NextFunction, Response } from 'express';
import { AuthRequest } from './authHandler.js';

/**
 * requireAdmin은 봇 요청을 그대로 통과시키므로(다른 라우트가 기대하는 동작),
 * 사람만 써야 하는 관리 라우트는 이걸 먼저 건다.
 */
export const rejectBot =
  (message: string) => (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.isBot) {
      return res.status(403).json({ status: 'error', message, data: null });
    }
    return next();
  };
