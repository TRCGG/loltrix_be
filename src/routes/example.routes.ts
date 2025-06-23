import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest';
import { createExample, getExampleById, getAllExamples } from '../controllers/example.controller';

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
router.post('/', validateRequest(createExampleSchema), createExample);

/**
 * @route GET /api/examples/:id
 * @desc Get example by ID
 * @access Public
 */
router.get('/:id', validateRequest(getExampleByIdSchema), getExampleById);

/**
 * @route GET /api/examples
 * @desc Get all examples
 * @access Public
 */
router.get('/', getAllExamples);

export default router;
