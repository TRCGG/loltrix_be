import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { createGuild, getGuildById, getAllGuilds, updateGuild } from '../controllers/guild.controller.js';

const router: Router = Router();

// Define Zod schemas for validation
const createGuildSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
    description: z.string().max(500, 'Description must be less than 500 characters').optional(),
  }),
});

const updateGuildSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters').optional(),
    description: z.string().max(500, 'Description must be less than 500 characters').optional(),
  }),
  params: z.object({
    id: z.string().uuid('Invalid guild ID format'),
  }),
});

const getGuildByIdSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid guild ID format'),
  }),
});

const getAllGuildsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/, 'Page must be a positive number').transform(Number).optional(),
    limit: z.string().regex(/^\d+$/, 'Limit must be a positive number').transform(Number).optional(),
    search: z.string().max(100, 'Search term must be less than 100 characters').optional(),
  }).optional(),
});

/**
 * @route POST /api/guilds
 * @desc 새로운 길드 생성
 * @access Public
 */
router.post('/', validateRequest(createGuildSchema), createGuild);

/**
 * @route GET /api/guilds/:id
 * @desc ID로 길드 조회
 * @access Public
 */
router.get('/:id', validateRequest(getGuildByIdSchema), getGuildById);

/**
 * @route PUT /api/guilds/:id
 * @desc ID로 길드 수정
 * @access Public
 */
router.put('/:id', validateRequest(updateGuildSchema), updateGuild);

/**
 * @route GET /api/guilds
 * @desc 페이지네이션과 검색으로 모든 길드 조회
 * @access Public
 */
router.get('/', validateRequest(getAllGuildsSchema), getAllGuilds);

export default router;