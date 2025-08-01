import { Request, Response } from 'express';

/**
 * @desc 헬스 체크 엔드포인트
 * @access Public
 */
export const getHealth = (req: Request, res: Response) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
  });
};
