import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Zod Schemas ---

const dateFilterSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
  query: z.object({
    year: z
      .string()
      .length(4, 'Year must be 4 digits (e.g., 2025)')
      .optional(),
    month: z
      .string()
      .min(1)
      .max(2, 'Month must be 1 or 2 digits')
      .optional(),
    championName: z
      .string()
      .max(32, 'championName must be less than 32 characters')
      .optional(),
    position: z
      .enum(['ALL','TOP', 'JUG', 'MID', 'ADC', 'SUP'])
      .optional(),
    season: z
      .string()
      .min(1)
      .max(16, 'season must be less than 16 characters')
      .optional(),
    page: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .optional(),
    sortBy: z
      .enum(['totalCount', 'winRate'])
      .optional(),
  }),
});

// --- Routes ---

/**
 * @route GET /api/statistics/:guildId/users
 * @desc 유저별 게임 통계 조회
 */
router.get(
  '/:guildId/users',
  decodeGuildIdMiddleware,
  validateRequest(dateFilterSchema),
  getUserGameStats
);

/**
 * @route GET /api/statistics/:guildId/champions
 * @desc 챔피언별 통계 조회
 */
router.get(
  '/:guildId/champions',
  decodeGuildIdMiddleware,
  validateRequest(dateFilterSchema), // 기존 스키마 재사용
  getChampionStats
);

export default router;