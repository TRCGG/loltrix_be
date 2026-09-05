import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { monthSchema, rangeRequiresMonths } from './monthQuery.js';

const router: Router = Router();

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
      gameType: z.string().regex(/^[123](,[123])*$/, 'gameType must be 1|2|3 (comma separated)').optional(),
      competitionId: z.string().regex(/^\d+$/).transform(Number).optional(),
    })
    .superRefine(rangeRequiresMonths),
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
    #swagger.description = '특정 길드 내 유저들의 게임 통계를 조회합니다. recent=최근 1개월, season=시즌 전체, range=시즌 기준 월 범위 검색을 지원합니다. gameType에 1이 없고 competitionId도 없으면(전 대회 합산) 시즌·기간 조건을 무시합니다. 각 항목에는 대회 지표 7개가 함께 오는데, competitionId를 준 조회에서만 값이 차고 그 밖에서는 전부 null입니다 — killParticipation은 (킬+어시) 합 ÷ 팀 킬 합 × 100(분모 0이면 0), damageShare는 챔피언 피해 합 ÷ 팀 챔피언 피해 합 × 100(분모 0이면 0), goldPerMin은 골드 합 ÷ (플레이 시간 합 ÷ 60), avgVisionScore는 시야 점수 평균, damagePerDeath는 챔피언 피해 합 ÷ 데스 합(데스가 0이면 피해 합), deadTimePct는 사망 시간 합 ÷ 게임 시간 합 × 100, multiKills는 { double, triple, quadra, penta } 합계입니다. 비율은 0~100이고 소수 둘째 자리에서 반올림합니다.'

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
    #swagger.parameters['gameType'] = {
      in: 'query',
      description: '1=일반내전 / 2=스크림 / 3=본경기. 콤마 구분 가능(예: 2,3). 생략 시 competitionId가 있으면 2,3, 없으면 1',
      type: 'string'
    }
    #swagger.parameters['competitionId'] = {
      in: 'query',
      description: '대회 ID. 주면 그 대회 경기만 집계하고 대회 지표 7개를 채웁니다',
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
    #swagger.description = '길드 내에서 플레이된 챔피언 통계를 조회합니다. recent=최근 1개월, season=시즌 전체, range=시즌 기준 월 범위 검색을 지원합니다. gameType에 1이 없고 competitionId도 없으면(전 대회 합산) 시즌·기간 조건을 무시합니다.'

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
