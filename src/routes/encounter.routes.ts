import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  getEncounterSummary,
  getEncounterGames,
  getFrequentOpponents,
} from '../controllers/encounter.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Schemas ---

const encounterBaseSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
  query: z.object({
    riotName1: z.string().min(1).max(128),
    riotNameTag1: z.string().max(128).optional(),
    riotName2: z.string().min(1).max(128),
    riotNameTag2: z.string().max(128).optional(),
    season: z.string().max(32).optional(),
    matchupPosition: z.enum(['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP']).optional(),
  }),
});

const encounterGamesSchema = z.object({
  params: encounterBaseSchema.shape.params,
  query: z.object({
    riotName1: z.string().min(1).max(128),
    riotNameTag1: z.string().max(128).optional(),
    riotName2: z.string().min(1).max(128),
    riotNameTag2: z.string().max(128).optional(),
    season: z.string().max(32).optional(),
    scenario: z.enum(['all', 'enemies', 'allies']).optional(),
    page: z.string().regex(/^\d+$/).refine((val) => Number(val) >= 1, { message: 'Page must be 1 or greater' }).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .refine((val) => Number(val) >= 1, { message: 'Limit must be 1 or greater' })
      .refine((val) => Number(val) <= 1000, { message: 'Limit must be 1000 or less' })
      .optional(),
  }),
});

const frequentOpponentsSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
  query: z.object({
    riotName: z.string().min(1).max(128),
    riotNameTag: z.string().max(128).optional(),
    season: z.string().max(32).optional(),
    period: z.enum(['recent', 'all']).optional(),
    sortBy: z.enum(['totalGames', 'winRate']).optional(),
    page: z.string().regex(/^\d+$/).refine((val) => Number(val) >= 1, { message: 'Page must be 1 or greater' }).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .refine((val) => Number(val) >= 1, { message: 'Limit must be 1 or greater' })
      .refine((val) => Number(val) <= 1000, { message: 'Limit must be 1000 or less' })
      .optional(),
  }),
});

// --- Routes ---

/**
 * @route GET /api/encounter/:guildId/summary
 * @desc 두 플레이어 상대 전적 종합 요약 조회
 */
router.get(
  '/:guildId/summary',
  /* #swagger.auto = false
    #swagger.tags = ['Encounter']
    #swagger.summary = '상대 전적 종합 요약'
    #swagger.description = '두 플레이어의 전체/아군/적 시나리오별 전적, KDA, 평균 지표, 모스트 챔피언, 라인 매트릭스, 인사이트를 조회합니다.'

    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['riotName1'] = { in: 'query', description: '플레이어 A Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag1'] = { in: 'query', description: '플레이어 A Riot Tag', type: 'string' }
    #swagger.parameters['riotName2'] = { in: 'query', description: '플레이어 B Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag2'] = { in: 'query', description: '플레이어 B Riot Tag', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 (미입력 시 현재 시즌)', type: 'string' }
    #swagger.parameters['matchupPosition'] = { in: 'query', description: '챔피언 매치업 라인 필터 (ALL 시 포지션 무관 집계)', type: 'string', enum: ['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP'] }
  */
  decodeGuildIdMiddleware,
  validateRequest(encounterBaseSchema),
  getEncounterSummary,
);

/**
 * @route GET /api/encounter/:guildId/games
 * @desc 두 플레이어 상대 전적 경기 목록 조회
 */
router.get(
  '/:guildId/games',
  /* #swagger.auto = false
    #swagger.tags = ['Encounter']
    #swagger.summary = '상대 전적 경기 목록'
    #swagger.description = '두 플레이어가 함께한 경기 목록을 조회합니다. scenario로 아군/적 필터링 가능합니다.'

    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['riotName1'] = { in: 'query', description: '플레이어 A Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag1'] = { in: 'query', description: '플레이어 A Riot Tag', type: 'string' }
    #swagger.parameters['riotName2'] = { in: 'query', description: '플레이어 B Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag2'] = { in: 'query', description: '플레이어 B Riot Tag', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌', type: 'string' }
    #swagger.parameters['scenario'] = { in: 'query', description: '필터: all | enemies | allies', type: 'string', enum: ['all', 'enemies', 'allies'] }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(encounterGamesSchema),
  getEncounterGames,
);

/**
 * @route GET /api/encounter/:guildId/frequent
 * @desc 자주 만난 상대 목록 조회
 */
router.get(
  '/:guildId/frequent',
  /* #swagger.auto = false
    #swagger.tags = ['Encounter']
    #swagger.summary = '자주 만난 상대 목록'
    #swagger.description = '최근 2개월(기본) 또는 전체 기간 기준으로 자주 만난 상대를 조회합니다.'

    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['riotName'] = { in: 'query', description: 'Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag'] = { in: 'query', description: 'Riot Tag', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 (미입력 시 현재 시즌)', type: 'string' }
    #swagger.parameters['period'] = { in: 'query', description: '기간: recent(최근 2개월) | all(전체)', type: 'string', enum: ['recent', 'all'] }
    #swagger.parameters['sortBy'] = { in: 'query', description: '정렬: totalGames(판수순) | winRate(승률순)', type: 'string', enum: ['totalGames', 'winRate'] }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(frequentOpponentsSchema),
  getFrequentOpponents,
);

export default router;
