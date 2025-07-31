import { Request, Response, NextFunction } from 'express';
import { ProblemDetails } from '../types/error.js';

export const errorHandler = (
  err: ProblemDetails,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const problem: ProblemDetails = {
    type: `uncaught error`,
    title: 'Internal Server Error',
    status: 500,
    detail: 'cannot catch errors',
    instance: req.originalUrl,
  };

  if (err) {
    next(err);
  } else {
    next(problem);
  }
};
