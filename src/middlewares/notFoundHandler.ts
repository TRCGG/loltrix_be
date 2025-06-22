import { Request, Response } from 'express';
import { ProblemDetails } from '../types/error';
import path from 'path';

export const notFoundHandler = (req: Request, res: Response): void => {
  const problem: ProblemDetails = {
    type: 'https://example.com/problems/not-found',
    title: 'Resource Not Found',
    status: 404,
    detail: `The requested resource ${req.originalUrl} was not found`,
    instance: req.originalUrl,
  };

  res.status(404).sendFile(path.join(__dirname, '../loltrix/404/404page.html'));
};
