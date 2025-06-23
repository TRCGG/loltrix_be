import { NextFunction, Request, Response } from 'express';
import { ProblemDetails } from '../types/error';

export const notFoundHandler = (req: Request, res: Response, next: NextFunction): void => {
  const problem: ProblemDetails = {
    type: 'https://example.com/problems/not-found',
    title: 'Resource Not Found',
    status: 404,
    detail: `The requested resource ${req.originalUrl} was not found`,
    instance: req.originalUrl,
  };
  next(problem);
};
