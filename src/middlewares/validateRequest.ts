import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ProblemDetails } from '../types/error.js';

type ParsedRequest = {
  body?: unknown;
  query?: unknown;
  params?: unknown;
};

export const validateRequest =
  (schema: AnyZodObject) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = (await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      })) as ParsedRequest;

      // zod는 선언 안 된 키를 버리므로, 컨트롤러가 읽는 키는 스키마에 전부 선언돼 있어야 한다.
      // 스키마가 다루지 않는 자리(body/query/params)는 원본을 그대로 둔다.
      if (schema.shape.body !== undefined && parsed.body !== undefined) {
        req.body = parsed.body;
      }
      if (schema.shape.query !== undefined && parsed.query !== undefined) {
        req.query = parsed.query as Request['query'];
      }
      if (schema.shape.params !== undefined && parsed.params !== undefined) {
        req.params = parsed.params as Request['params'];
      }

      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const problem: ProblemDetails = {
          type: 'https://example.com/problems/validation-error',
          title: 'Validation Failed',
          status: 400,
          detail: 'The request payload failed validation',
          instance: req.originalUrl,
          errors: error.errors.map((err) => ({
            code: err.code,
            path: err.path.join('.'),
            message: err.message,
            value: 'received' in err ? err.received : undefined,
          })),
        };

        res.status(400).setHeader('Content-Type', 'application/problem+json').json(problem);
      } else {
        next(error);
      }
    }
  };
