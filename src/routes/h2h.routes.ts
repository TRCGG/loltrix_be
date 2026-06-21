import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getFrequentOpponents, getH2hDetail } from '../controllers/h2h.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Schemas ---

const frequentSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
  query: z.object({
    riotName: z.string().min(1).max(128),
    riotNameTag: z.string().max(128).optional(),
    q: z.string().max(128).optional(),
    season: z.string().max(32).optional(),
    limit: z
      .string()
      .regex(/^\d+$/)
      .refine((val) => Number(val) >= 1, { message: 'Limit must be 1 or greater' })
      .refine((val) => Number(val) <= 50, { message: 'Limit must be 50 or less' })
      .optional(),
  }),
});

const detailSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
  query: z.object({
    riotName1: z.string().min(1).max(128),
    riotNameTag1: z.string().max(128).optional(),
    riotName2: z.string().min(1).max(128),
    riotNameTag2: z.string().max(128).optional(),
    season: z.string().max(32).optional(),
    recentLimit: z.string().regex(/^\d+$/).optional(),
    recentOffset: z.string().regex(/^\d+$/).optional(),
  }),
});

// --- Routes ---

/**
 * @route GET /api/h2h/:guildId/frequent
 * @desc 자주 만난 상대 목록 조회 (검색 자동완성 겸용)
 */
router.get(
  '/:guildId/frequent',
  /* #swagger.auto = false
    #swagger.tags = ['H2H']
    #swagger.summary = '자주 만난 상대 목록'
    #swagger.description = '기준 유저(me)가 맞붙은(다른 팀) 상대를 본계정 단위로 집계합니다. 시즌 기준, matchups 내림차순. q로 닉네임#태그 부분일치 필터(검색 자동완성 겸용).'

    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['riotName'] = { in: 'query', description: '기준 유저 Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag'] = { in: 'query', description: '기준 유저 Riot Tag', type: 'string' }
    #swagger.parameters['q'] = { in: 'query', description: '상대 닉네임#태그 부분일치 검색어', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 (미입력 현재시즌, all 전체)', type: 'string' }
    #swagger.parameters['limit'] = { in: 'query', description: '개수 (기본 10, 최대 50)', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(frequentSchema),
  getFrequentOpponents,
);

/**
 * @route GET /api/h2h/:guildId
 * @desc 두 유저 상대전적 상세 (against + together 단일 응답)
 */
router.get(
  '/:guildId',
  /* #swagger.auto = false
    #swagger.tags = ['H2H']
    #swagger.summary = '상대전적 상세 (맞붙은 + 함께한)'
    #swagger.description = '두 유저의 프로필·메타 + against(요약/스트릭·평균지표·라인매트릭스·가장많이맞붙은라인(topLane)·챔피언매치업·인사이트·최근 맞대결) + together(요약/스트릭·라인조합·가장많이함께한조합(topLaneCombo)·듀오픽·최근 함께한)를 단일 응답으로 조회합니다.'

    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['riotName1'] = { in: 'query', description: '유저 A Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag1'] = { in: 'query', description: '유저 A Riot Tag', type: 'string' }
    #swagger.parameters['riotName2'] = { in: 'query', description: '유저 B Riot Name', required: true, type: 'string' }
    #swagger.parameters['riotNameTag2'] = { in: 'query', description: '유저 B Riot Tag', type: 'string' }
    #swagger.parameters['season'] = { in: 'query', description: '시즌 (미입력 현재시즌, all 전체)', type: 'string' }
    #swagger.parameters['recentLimit'] = { in: 'query', description: '최근 맞대결 개수 (기본 6)', type: 'integer' }
    #swagger.parameters['recentOffset'] = { in: 'query', description: '최근 맞대결 offset', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(detailSchema),
  getH2hDetail,
);

export default router;
