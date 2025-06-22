import { Request, Response, NextFunction } from 'express';
import { ProblemDetails } from '../types/error';

interface AppError extends Error {
  status?: number;
  statusCode?: number;
}

export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
): void => {
  const statusCode = err.statusCode || err.status || 500;

  const problem: ProblemDetails = {
    type: `https://example.com/problems/${statusCode}`,
    title: err.message || 'Internal Server Error',
    status: statusCode,
    detail: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    instance: req.originalUrl,
  };

  res.status(statusCode).setHeader('Content-Type', 'application/problem+json').json(problem);
};
