import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest';

const router: Router = Router();

// Define Zod schemas for validation
const createExampleSchema = z.object({
  body: z.object({
    name: z.string().min(3).max(50),
    email: z.string().email(),
    age: z.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
  }),
});

const getExampleByIdSchema = z.object({
  params: z.object({
    id: z.string().uuid(),
  }),
});

/**
 * @route POST /api/examples
 * @desc Create a new example
 * @access Public
 */
router.post('/', validateRequest(createExampleSchema), (req: Request, res: Response) => {
  // In a real app, you would save to a database here
  res.status(201).json({
    status: 'success',
    message: 'Example created successfully',
    data: req.body,
  });
});

/**
 * @route GET /api/examples/:id
 * @desc Get example by ID
 * @access Public
 */
router.get('/:id', validateRequest(getExampleByIdSchema), (req: Request, res: Response) => {
  // In a real app, you would fetch from a database here
  res.status(200).json({
    status: 'success',
    message: 'Example retrieved successfully',
    data: {
      id: req.params.id,
      name: 'Example Name',
      email: 'example@example.com',
      age: 30,
      tags: ['tag1', 'tag2'],
    },
  });
});

/**
 * @route GET /api/examples
 * @desc Get all examples
 * @access Public
 */
router.get('/', (req: Request, res: Response) => {
  // In a real app, you would fetch from a database here
  res.status(200).json({
    status: 'success',
    message: 'Examples retrieved successfully',
    data: [
      {
        id: '123e4567-e89b-12d3-a456-426614174000',
        name: 'Example 1',
        email: 'example1@example.com',
      },
      {
        id: '223e4567-e89b-12d3-a456-426614174000',
        name: 'Example 2',
        email: 'example2@example.com',
      },
    ],
  });
});

export default router;
