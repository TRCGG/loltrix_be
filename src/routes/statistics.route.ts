import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Zod Schemas ---

const filterSchema = z.object({
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
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '유저별 게임 통계'
    #swagger.description = '특정 길드 내 유저들의 게임 통계(승률, 판수 등)를 다양한 필터로 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['year'] = { in: 'query', description: '년도 (YYYY)', type: 'string' }
    #swagger.parameters['month'] = { in: 'query', description: '월 (1~12)', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 (예: S14-2)', type: 'string' }
    #swagger.parameters['position'] = { 
      in: 'query', 
      description: '포지션 필터', 
      type: 'string', 
      enum: ['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP'] 
    }
    #swagger.parameters['championName'] = { in: 'query', description: '특정 챔피언 플레이 기록 필터', type: 'string' }
    #swagger.parameters['sortBy'] = { 
      in: 'query', 
      description: '정렬 기준 (판수/승률)', 
      type: 'string', 
      enum: ['totalCount', 'winRate'] 
    }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(filterSchema),
  getUserGameStats
);

/**
 * @route GET /api/statistics/:guildId/champions
 * @desc 챔피언별 통계 조회
 */
router.get(
  '/:guildId/champions',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '챔피언별 통계'
    #swagger.description = '길드 내에서 플레이된 챔피언들의 통계를 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['year'] = { in: 'query', description: '년도 (YYYY)', type: 'string' }
    #swagger.parameters['month'] = { in: 'query', description: '월 (1~12)', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌', type: 'string' }
    #swagger.parameters['position'] = { 
      in: 'query', 
      description: '포지션 필터', 
      type: 'string', 
      enum: ['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP'] 
    }
    #swagger.parameters['sortBy'] = { 
      in: 'query', 
      description: '정렬 기준', 
      type: 'string', 
      enum: ['totalCount', 'winRate'] 
    }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(filterSchema), // 기존 스키마 재사용
  getChampionStats
);

export default router;