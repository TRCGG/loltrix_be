import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { monthSchema, rangeRequiresMonths } from './monthQuery.js';
import {
  getChampionCombinations,
  getDuos,
  getActivity,
  getRisingStars,
  getHighlights,
  getWinStreaks,
} from '../controllers/clanLeaderboard.controller.js';
import {
  combinationFilterSchema,
  duoFilterSchema,
  activityFilterSchema,
  metricFilterSchema,
} from './clanLeaderboard.query.js';

const router: Router = Router();

export const filterSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
  query: z
    .object({
      datePreset: z.enum(['recent', 'recent30', 'season', 'range']).optional(),
      fromMonth: monthSchema.optional(),
      toMonth: monthSchema.optional(),
      championName: z.string().max(32, 'championName must be less than 32 characters').optional(),
      position: z.enum(['ALL', 'TOP', 'JUG', 'MID', 'ADC', 'SUP']).optional(),
      season: z.string().min(1).max(32, 'season must be less than 32 characters').optional(),
      page: z.string().regex(/^\d+$/).transform(Number).optional(),
      limit: z.string().regex(/^\d+$/).transform(Number).optional(),
      sortBy: z.enum(['totalCount', 'winRate']).optional(),
      gameType: z
        .string()
        .regex(/^[123](,[123])*$/, 'gameType must be 1|2|3 (comma separated)')
        .optional(),
    })
    .superRefine(rangeRequiresMonths),
});

export const championFilterSchema = filterSchema.extend({
  query: filterSchema.shape.query
    .innerType()
    .extend({
      sortBy: z.enum(['totalCount', 'winRate', 'pickRate', 'wilsonScore']).optional(),
    })
    .superRefine((query, ctx) => {
      rangeRequiresMonths(query, ctx);
      if (query.sortBy === 'pickRate' || query.sortBy === 'wilsonScore') {
        if (query.gameType && query.gameType.split(',').some((type) => type !== '1')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['gameType'],
            message: 'Leaderboard rankings support normal matches only',
          });
        }
        for (const field of ['page', 'limit'] as const) {
          const value = query[field];
          if (
            value !== undefined &&
            (!Number.isSafeInteger(value) || value < 1 || (field === 'limit' && value > 100))
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: 'Invalid leaderboard pagination',
            });
          }
        }
      }
    }),
});

export const userFilterSchema = filterSchema.extend({
  query: filterSchema.shape.query
    .innerType()
    .extend({
      sortBy: z.enum(['totalCount', 'winRate', 'wilsonScore']).optional(),
    })
    .superRefine((query, ctx) => {
      rangeRequiresMonths(query, ctx);
      if (query.sortBy !== 'wilsonScore') return;
      if (query.gameType && query.gameType.split(',').some((type) => type !== '1')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gameType'],
          message: 'Leaderboard rankings support normal matches only',
        });
      }
      for (const field of ['page', 'limit'] as const) {
        const value = query[field];
        if (
          value !== undefined &&
          (!Number.isSafeInteger(value) || value < 1 || (field === 'limit' && value > 100))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: 'Invalid leaderboard pagination',
          });
        }
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
    #swagger.description = '특정 길드 내 유저들의 게임 통계를 조회합니다. sortBy=wilsonScore는 일반내전 전용 우수 성적 랭킹 TOP5이며, 기본 recent는 최근 30일, STATS_MIN_GAME_COUNT 이상을 Wilson 95% 하한으로 정렬합니다. 이 모드의 position=ALL 또는 생략은 전 포지션을 합산하고, 특정 포지션은 최소 판수 적용 전에 필터링합니다. 기존 totalCount·winRate의 기본 recent는 최근 1개월이며 recent30을 명시하면 최근 30일입니다. gameType에 1이 없으면(대회 유형 합산) 시즌·기간 조건을 무시합니다. 대회 하나의 유저 랭킹은 GET /api/competitions/{guildId}/{competitionId}/statistics/users 로 조회합니다.'

    #swagger.parameters['guildId'] = {
      in: 'path',
      description: '길드 ID',
      required: true,
      type: 'string'
    }
    #swagger.parameters['datePreset'] = {
      in: 'query',
      description: '기존 정렬 recent=최근 1개월, 새 리더보드 정렬 recent=최근 30일. recent30=최근 30일, season=시즌 전체, range=기간 선택',
      type: 'string',
      enum: ['recent', 'recent30', 'season', 'range']
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
      description: 'wilsonScore=우수 성적 랭킹 TOP5 (일반내전 전용, Wilson 95% 하한)',
      type: 'string',
      enum: ['totalCount', 'winRate', 'wilsonScore']
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
      description: '1=일반내전 / 2=스크림 / 3=본경기. 콤마 구분 가능(예: 2,3). 생략 시 1',
      type: 'string'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(userFilterSchema),
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
    #swagger.description = '길드 내 챔피언 통계. 기존 정렬 recent=최근 1개월, pickRate·wilsonScore recent=최근 30일, recent30=최근 30일, season=시즌 전체, range=시즌 기준 월 범위. pickRate·wilsonScore는 일반내전 전용이며 기본 5개를 반환합니다. 두 모드의 position=ALL 또는 생략은 모든 포지션 합산입니다. matchCount는 고유 등장 경기 수, totalMatches는 포지션과 무관한 기간 내 전체 경기 수, pickRate는 두 값의 비율(%), wilsonScore는 95% 윌슨 하한입니다. 기존 totalCount·winRate 동작은 유지하며 gameType에 1이 없으면 시즌·기간 조건을 무시합니다. 대회 하나의 통계는 /api/competitions/{guildId}/{competitionId}/statistics/champions 에서 조회합니다.'

    #swagger.parameters['guildId'] = {
      in: 'path',
      description: '길드 ID',
      required: true,
      type: 'string'
    }
    #swagger.parameters['datePreset'] = {
      in: 'query',
      description: '기존 정렬 recent=최근 1개월, 새 리더보드 정렬 recent=최근 30일. recent30=최근 30일, season=시즌 전체, range=기간 선택',
      type: 'string',
      enum: ['recent', 'recent30', 'season', 'range']
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
      description: 'pickRate=고유 경기 픽률, wilsonScore=최소 판수를 충족한 챔피언 메타',
      type: 'string',
      enum: ['totalCount', 'winRate', 'pickRate', 'wilsonScore']
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
  validateRequest(championFilterSchema),
  getChampionStats,
);

router.get(
  '/:guildId/rising-stars',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '최근 30일 상승세 TOP 5'
    #swagger.description = '일반내전 등록일 기준 최근 30일과 직전 30일을 비교합니다. 양쪽 기간 각각 10판 이상이며 승률 상승폭이 양수인 현재 본캐 멤버만 반환합니다. data는 playerCode, riotName, riotNameTag, previous/current의 totalCount·win·winRate(%), improvementPp(승률 퍼센트포인트 차이)를 담은 TOP 5 배열입니다. query는 season만 허용합니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON' }
  */
  decodeGuildIdMiddleware,
  validateRequest(metricFilterSchema),
  getRisingStars,
);

router.get(
  '/:guildId/highlights',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '최근 30일 내전 명장면'
    #swagger.description = '최근 30일 일반내전 등록일 기준입니다. data의 kills, assists, championDamage, visionScore, damageTaken, buildingDamage(건물 피해)는 단일 경기 공동 최고 value와 모든 공동 1위 entries를 반환합니다. entries는 본캐 식별자, 챔피언, registeredDate(등록일 YYYY-MM-DD), value를 담습니다. 경기 없는 항목은 value=null, entries=[]입니다. pentakills는 본캐 기준 totalPlayers, totalPentaKills, 경기별 entries의 pentaKills를 반환하며 여러 펜타킬은 횟수대로 합산합니다. query는 season만 허용합니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON' }
  */
  decodeGuildIdMiddleware,
  validateRequest(metricFilterSchema),
  getHighlights,
);

router.get(
  '/:guildId/win-streaks',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '최근 30일 현재 연승 TOP 5'
    #swagger.description = '최근 30일 일반내전 등록 경기부터 역순으로 비승리 전까지 이어진 2연승 이상 현재 연승 TOP 5를 반환합니다. data는 본캐 식별자, streak, latestRegisteredDate(등록일 YYYY-MM-DD)를 담습니다. 최고 연승은 포함하지 않으며 동시 등록 경기에는 경기 ID와 참가자 ID 역순을 적용합니다. query는 season만 허용합니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON' }
  */
  decodeGuildIdMiddleware,
  validateRequest(metricFilterSchema),
  getWinStreaks,
);

router.get(
  '/:guildId/champion-combinations',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '강한 챔피언 조합'
    #swagger.description = '일반내전의 같은 팀 ADC+SUP 또는 MID+JUG 조합. STATS_MIN_GAME_COUNT 이상을 Wilson 95% 하한으로 정렬합니다. 포지션 필터는 적용하지 않습니다. data 배열의 각 행은 champions[{champName,champNameEng,position}], totalCount, win, lose, winRate(%), wilsonScore, playerPairCount(본캐 기준 고유 플레이어 쌍 수)를 반환합니다. 페이지 정보는 X-Total-Count, X-Page, X-Limit, X-Total-Pages 헤더에 제공합니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['combination'] = { in: 'query', required: true, type: 'string', enum: ['ADCSUP', 'MIDJUG'] }
    #swagger.parameters['datePreset'] = { in: 'query', type: 'string', enum: ['recent', 'recent30', 'season', 'range'], description: '기본 recent=최근 30일. recent30=최근 30일' }
    #swagger.parameters['fromMonth'] = { in: 'query', type: 'string', description: 'range 시작 월 (1~12)' }
    #swagger.parameters['toMonth'] = { in: 'query', type: 'string', description: 'range 종료 월 (1~12)' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON. range일 때 필수' }
    #swagger.parameters['page'] = { in: 'query', type: 'integer', default: 1 }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', default: 5, minimum: 1, maximum: 100 }
  */
  decodeGuildIdMiddleware,
  validateRequest(combinationFilterSchema),
  getChampionCombinations,
);

router.get(
  '/:guildId/duos',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '함께한 판수 듀오 순위'
    #swagger.description = '일반내전에서 같은 팀으로 함께한 두 플레이어의 경기 수 순위. 부캐는 본캐로 합산하며 포지션 필터와 최소 판수는 적용하지 않습니다. data 배열의 각 행은 players[{playerCode,riotName,riotNameTag}], totalCount, win, lose, winRate(%)를 반환합니다. 페이지 정보는 X-Total-Count, X-Page, X-Limit, X-Total-Pages 헤더에 제공합니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['datePreset'] = { in: 'query', type: 'string', enum: ['recent', 'recent30', 'season', 'range'], description: '기본 recent=최근 30일. recent30=최근 30일' }
    #swagger.parameters['fromMonth'] = { in: 'query', type: 'string', description: 'range 시작 월 (1~12)' }
    #swagger.parameters['toMonth'] = { in: 'query', type: 'string', description: 'range 종료 월 (1~12)' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON. range일 때 필수' }
    #swagger.parameters['page'] = { in: 'query', type: 'integer', default: 1 }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', default: 5, minimum: 1, maximum: 100 }
  */
  decodeGuildIdMiddleware,
  validateRequest(duoFilterSchema),
  getDuos,
);

router.get(
  '/:guildId/activity',
  /* #swagger.auto = false
    #swagger.tags = ['Statistics']
    #swagger.summary = '내전 집계 규모와 일별 경기 수'
    #swagger.description = '등록일 기준 일반내전 경기 수, 본캐 기준 참여자 수, 날짜별 경기 수. 포지션 필터는 적용하지 않습니다. data는 {totalMatches,totalPlayers,dailyMatches:[{date,matchCount}]} 객체입니다. date는 YYYY-MM-DD이며 경기 없는 날짜는 배열에 포함하지 않습니다.'
    #swagger.parameters['guildId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['datePreset'] = { in: 'query', type: 'string', enum: ['recent', 'recent30', 'season', 'range'], description: '기본 recent=최근 30일. recent30=최근 30일' }
    #swagger.parameters['fromMonth'] = { in: 'query', type: 'string', description: 'range 시작 월 (1~12)' }
    #swagger.parameters['toMonth'] = { in: 'query', type: 'string', description: 'range 종료 월 (1~12)' }
    #swagger.parameters['season'] = { in: 'query', type: 'string', description: '기본 LOL_SEASON. range일 때 필수' }
  */
  decodeGuildIdMiddleware,
  validateRequest(activityFilterSchema),
  getActivity,
);

export default router;
