import { Request, Response } from 'express';
import { ProblemDetails } from '../types/error';

// next(problem)으로 errorHandler에 넘기지 않는다 — Error가 아닌 객체는 message가 없어
// "Unknown error"로 error_log에 적재되고, 스캐너 봇의 404가 그대로 DB 노이즈가 된다.
export const notFoundHandler = (req: Request, res: Response): void => {
  const problem: ProblemDetails = {
    type: 'https://example.com/problems/not-found',
    title: 'Resource Not Found',
    status: 404,
    detail: `The requested resource ${req.originalUrl} was not found`,
    instance: req.originalUrl,
  };
  res.status(404).json(problem);
};
