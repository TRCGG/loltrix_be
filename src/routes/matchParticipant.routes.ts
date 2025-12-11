import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { 
  getRecentGames, 
  getMatchDashboard, 
  getMostPicks,
  getGameDetail,
  deleteMatch,
} from '../controllers/matchParticipant.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Zod Schemas ---

// 최근 게임 목록 및 모스트 픽 조회용 스키마
const matchListSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
    riotName: z
      .string()
      .min(1, 'riotName is required')
      .max(128, 'riotName must be less than 128 characters'),
  }),
  query: z.object({
    riotNameTag: z
      .string()
      .max(128, 'riotNameTag must be less than 128 characters')
      .optional(),
    season: z
      .string()
      .max(32, 'season must be less than 32 characters')
      .optional(),
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
  }),
});

const matchDashboardSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
    riotName: z
      .string()
      .min(1, 'riotName is required')
      .max(128, 'riotName must be less than 128 characters'),
  }),
  query: z.object({
    riotNameTag: z
      .string()
      .max(128, 'Search term must be less than 128 characters')
      .optional(),
    season: z
      .string()
      .max(32, 'season must be less than 32 characters')
      .optional(),
  }),
});

// 게임 상세 조회용 스키마
const gameDetailSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
    gameId: z.string().min(1).max(255), // Game ID 길이 넉넉하게
  }),
});

// --- Routes ---

/**
 * @route GET /api/matches/:guildId/:riotName/games
 * @desc 최근 게임 목록 (상세)
 */
router.get(
  '/:guildId/:riotName/games',
  decodeGuildIdMiddleware,
  validateRequest(matchListSchema),
  getRecentGames
);

/**
 * @route GET /api/matches/:guildId/:riotName/dashboard
 * @desc 전적 요약 + 라인별 통계 + 모스트 픽(TOP 5) 통합 조회
 */
router.get(
  '/:guildId/:riotName/dashboard',
  decodeGuildIdMiddleware,
  validateRequest(matchDashboardSchema),
  getMatchDashboard
); 

/**
 * @route GET /api/matches/:guildId/:riotName/most-picks
 * @desc 모스트 픽 상세 목록 (페이징 가능)
 */
router.get(
  '/:guildId/:riotName/most-picks',
  decodeGuildIdMiddleware,
  validateRequest(matchListSchema),
  getMostPicks
);

/**
 * @route GET /api/matches/:guildId/games/:gameId
 * @desc 특정 게임 상세 조회 (10명 플레이어 정보)
 */
router.get(
  '/:guildId/games/:gameId',
  decodeGuildIdMiddleware,
  validateRequest(gameDetailSchema),
  getGameDetail
);

/**
 * @route DELETE /api/matches/:guildId/games/:gameId
 * @desc 게임 기록 삭제 (소프트 삭제)
 */
router.delete(
  '/:guildId/games/:gameId',
  decodeGuildIdMiddleware,
  validateRequest(gameDetailSchema),
  deleteMatch,
);

export default router;