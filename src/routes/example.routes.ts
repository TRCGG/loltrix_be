import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { createExample, getExampleById, getAllExamples } from '../controllers/example.controller.js';

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
 * @desc 새로운 예제 생성
 * @access Public
 */
router.post('/', validateRequest(createExampleSchema), createExample);

/**
 * @route GET /api/examples/:id
 * @desc ID로 예제 조회
 * @access Public
 */
router.get('/:id', validateRequest(getExampleByIdSchema), getExampleById);

/**
 * @route GET /api/examples
 * @desc 모든 예제 조회
 * @access Public
 */
router.get('/', getAllExamples);

export default router;
