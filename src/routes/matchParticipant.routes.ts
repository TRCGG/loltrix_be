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
  /* #swagger.auto = false
    #swagger.tags = ['Matches']
    #swagger.summary = '최근 게임 목록 조회'
    #swagger.description = '특정 유저의 최근 게임 전적 리스트를 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['riotName'] = { 
      in: 'path', 
      description: 'Riot Name', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['riotNameTag'] = { in: 'query', description: 'Riot Tag (선택)', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 필터 (예: S13)', type: 'string' }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
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
  /* #swagger.auto = false
    #swagger.tags = ['Matches']
    #swagger.summary = '전적 대시보드 조회'
    #swagger.description = '전적 요약, 라인별 통계, 모스트 5 챔피언 정보를 통합 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['riotName'] = { 
      in: 'path', 
      description: 'Riot Name', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['riotNameTag'] = { in: 'query', description: 'Riot Tag (선택)', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 필터', type: 'string' }
  */
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
  /* #swagger.auto = false
    #swagger.tags = ['Matches']
    #swagger.summary = '모스트 픽 상세 조회'
    #swagger.description = '플레이한 챔피언들의 상세 통계 목록을 조회합니다 (페이징 지원).'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['riotName'] = { 
      in: 'path', 
      description: 'Riot Name', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 필터', type: 'string' }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
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
  /* #swagger.auto = false
    #swagger.tags = ['Matches']
    #swagger.summary = '게임 상세 조회'
    #swagger.description = '특정 게임의 상세 정보(참여자 10명 포함)를 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['gameId'] = { 
      in: 'path', 
      description: 'Game ID', 
      required: true,
      type: 'string'
    }
  */
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
  /* #swagger.auto = false
    #swagger.tags = ['Matches']
    #swagger.summary = '게임 기록 삭제'
    #swagger.description = '특정 게임 기록을 삭제(숨김) 처리합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path', 
      description: '길드 ID', 
      required: true,
      type: 'string'
    }
    #swagger.parameters['gameId'] = { 
      in: 'path', 
      description: 'Game ID', 
      required: true,
      type: 'string'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(gameDetailSchema),
  deleteMatch,
);

export default router;