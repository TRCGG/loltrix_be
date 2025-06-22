import { Request, Response, NextFunction } from 'express';
import { AnyZodObject, ZodError } from 'zod';
import { ProblemDetails } from '../types/error';

export const validateRequest =
  (schema: AnyZodObject) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const problem: ProblemDetails = {
          type: 'https://example.com/problems/validation-error',
          title: 'Validation Failed',
          status: 400,
          detail: 'The request payload failed validation',
          instance: req.originalUrl,
          errors: error.errors,
        };

        res.status(400).setHeader('Content-Type', 'application/problem+json').json(problem);
      } else {
        next(error);
      }
    }
  };
