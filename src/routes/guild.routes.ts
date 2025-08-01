import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  createGuild,
  getGuildById,
  getAllGuilds,
  updateGuild,
  deleteGuild,
} from '../controllers/guild.controller.js';

const router: Router = Router();

// Define Zod schemas for validation
const createGuildSchema = z.object({
  body: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
    guildName: z
      .string()
      .min(1, 'Guild name is required')
      .max(128, 'Guild name must be less than 128 characters'),
    lanId: z.string().max(32, 'LAN ID must be less than 32 characters').optional(),
  }),
});

const updateGuildSchema = z.object({
  body: z.object({
    guildName: z
      .string()
      .min(1, 'Guild name is required')
      .max(128, 'Guild name must be less than 128 characters')
      .optional(),
    lanId: z.string().max(32, 'LAN ID must be less than 32 characters').optional(),
    deleteYn: z
      .enum(['Y', 'N'], { errorMap: () => ({ message: 'Delete flag must be Y or N' }) })
      .optional(),
  }),
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const getGuildByIdSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const getAllGuildsSchema = z.object({
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, 'Page must be a positive number')
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, 'Limit must be a positive number')
        .transform(Number)
        .optional(),
      search: z.string().max(128, 'Search term must be less than 128 characters').optional(),
    })
    .optional(),
});

const deleteGuildSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

/**
 * @route POST /api/guilds
 * @desc 새로운 길드 생성
 * @access Public
 */
router.post('/', validateRequest(createGuildSchema), createGuild);

/**
 * @route GET /api/guilds/:guildId
 * @desc Guild ID로 길드 조회
 * @access Public
 */
router.get('/:guildId', validateRequest(getGuildByIdSchema), getGuildById);

/**
 * @route PUT /api/guilds/:guildId
 * @desc Guild ID로 길드 수정
 * @access Public
 */
router.put('/:guildId', validateRequest(updateGuildSchema), updateGuild);

/**
 * @route GET /api/guilds
 * @desc 페이지네이션과 검색으로 모든 길드 조회
 * @access Public
 */
router.get('/', validateRequest(getAllGuildsSchema), getAllGuilds);

/**
 * @route DELETE /api/guilds/:guildId
 * @desc Guild ID로 길드 삭제 (소프트 삭제)
 * @access Public
 */
router.delete('/:guildId', validateRequest(deleteGuildSchema), deleteGuild);

export default router;
