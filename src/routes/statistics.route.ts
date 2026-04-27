import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

const monthSchema = z
  .string()
  .regex(/^\d{1,2}$/, 'Month must be 1 or 2 digits')
  .refine((value) => {
    const month = Number(value);
    return month >= 1 && month <= 12;
  }, 'Month must be between 1 and 12');

const filterSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
  query: z
    .object({
      datePreset: z.enum(['recent', 'season', 'range']).optional(),
      fromMonth: monthSchema.optional(),
      toMonth: monthSchema.optional(),
      championName: z.string().max(32, 'championName must be less than 32 characters').optional(),
      position: z.enum(['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP']).optional(),
      season: z.string().min(1).max(32, 'season must be less than 32 characters').optional(),
      page: z.string().regex(/^\d+$/).transform(Number).optional(),
      limit: z.string().regex(/^\d+$/).transform(Number).optional(),
      sortBy: z.enum(['totalCount', 'winRate']).optional(),
    })
    .superRefine((query, ctx) => {
      if (query.datePreset !== 'range') {
        return;
      }

      if (!query.fromMonth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'fromMonth is required when datePreset=range',
          path: ['fromMonth'],
        });
      }

      if (!query.toMonth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toMonth is required when datePreset=range',
          path: ['toMonth'],
        });
      }

      if (!query.season) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'season is required when datePreset=range',
          path: ['season'],
        });
      }
    }),
});

/**
 * @route GET /api/statistics/:guildId/users
 * @desc 유저별 게임 통계 조회
 */
router.get(
  '/:guildId/users',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '유저별 게임 통계'
    #swagger.description = '특정 길드 내 유저들의 게임 통계를 조회합니다. recent=최근 1개월, season=시즌 전체, range=시즌 기준 월 범위 검색을 지원합니다.'

    #swagger.parameters['guildId'] = {
      in: 'path',
      description: '길드 ID',
      required: true,
      type: 'string'
    }
    #swagger.parameters['datePreset'] = {
      in: 'query',
      description: '조회 방식. recent=최근 1개월, season=시즌 전체, range=기간 선택',
      type: 'string',
      enum: ['recent', 'season', 'range']
    }
    #swagger.parameters['fromMonth'] = {
      in: 'query',
      description: '기간 선택 시작 월 (1~12). datePreset=range일 때 필수',
      type: 'string'
    }
    #swagger.parameters['toMonth'] = {
      in: 'query',
      description: '기간 선택 종료 월 (1~12). datePreset=range일 때 필수',
      type: 'string'
    }
    #swagger.parameters['season'] = {
      in: 'query',
      description: '시즌 필터. datePreset=range일 때 필수입니다. 미입력 시 LOL_SEASON 기본값 사용',
      type: 'string'
    }
    #swagger.parameters['position'] = {
      in: 'query',
      description: '포지션 필터',
      type: 'string',
      enum: ['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP']
    }
    #swagger.parameters['championName'] = {
      in: 'query',
      description: '특정 챔피언 플레이 기록 필터',
      type: 'string'
    }
    #swagger.parameters['sortBy'] = {
      in: 'query',
      description: '정렬 기준',
      type: 'string',
      enum: ['totalCount', 'winRate']
    }
    #swagger.parameters['page'] = {
      in: 'query',
      description: '페이지 번호',
      type: 'integer'
    }
    #swagger.parameters['limit'] = {
      in: 'query',
      description: '페이지당 개수',
      type: 'integer'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(filterSchema),
  getUserGameStats,
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
    #swagger.description = '길드 내에서 플레이된 챔피언 통계를 조회합니다. recent=최근 1개월, season=시즌 전체, range=시즌 기준 월 범위 검색을 지원합니다.'

    #swagger.parameters['guildId'] = {
      in: 'path',
      description: '길드 ID',
      required: true,
      type: 'string'
    }
    #swagger.parameters['datePreset'] = {
      in: 'query',
      description: '조회 방식. recent=최근 1개월, season=시즌 전체, range=기간 선택',
      type: 'string',
      enum: ['recent', 'season', 'range']
    }
    #swagger.parameters['fromMonth'] = {
      in: 'query',
      description: '기간 선택 시작 월 (1~12). datePreset=range일 때 필수',
      type: 'string'
    }
    #swagger.parameters['toMonth'] = {
      in: 'query',
      description: '기간 선택 종료 월 (1~12). datePreset=range일 때 필수',
      type: 'string'
    }
    #swagger.parameters['season'] = {
      in: 'query',
      description: '시즌 필터. datePreset=range일 때 필수입니다. 미입력 시 LOL_SEASON 기본값 사용',
      type: 'string'
    }
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
    #swagger.parameters['page'] = {
      in: 'query',
      description: '페이지 번호',
      type: 'integer'
    }
    #swagger.parameters['limit'] = {
      in: 'query',
      description: '페이지당 개수',
      type: 'integer'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(filterSchema),
  getChampionStats,
);

export default router;
