import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { issueCodes, getNextCode } from '../controllers/tournament.controller.js';

const router: Router = Router();

// --- Schemas ---

const issueCodesSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'guildId is required').max(128),
    channelId: z.string().min(1, 'channelId is required').max(128),
    count: z
      .number({ invalid_type_error: 'count must be a number' })
      .int()
      .min(1, 'count must be 1 or greater')
      .max(50, 'count must be 50 or less'),
  }),
});

const nextCodeSchema = z.object({
  query: z.object({
    guildId: z.string().min(1, 'guildId is required').max(128),
  }),
});

// --- Routes ---

/**
 * @route POST /api/tournament/codes
 * @desc 토너먼트 코드 발급 (봇 전용). 기존 인증 체인(restrictBotToLocalhost, verifyAuth) 아래 구역.
 */
router.post(
  '/codes',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '토너먼트 코드 발급 (봇 전용)'
    #swagger.description = 'count개 코드를 선발급하여 tournament_code(PENDING)로 저장합니다. channelId는 metadata에 저장되어 콜백 시 다음 코드 게시 대상이 됩니다.'
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { guildId: '123', channelId: '456', count: 3 }
    }
  */
  validateRequest(issueCodesSchema),
  issueCodes,
);

/**
 * @route GET /api/tournament/next-code
 * @desc 미사용 다음 코드 조회 (봇 !다음코드 용).
 */
router.get(
  '/next-code',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '미사용 다음 코드 조회'
    #swagger.description = 'PENDING 코드 중 issued_date 오름차순 첫 코드를 반환합니다.'
    #swagger.parameters['guildId'] = { in: 'query', description: '길드 ID', required: true, type: 'string' }
  */
  validateRequest(nextCodeSchema),
  getNextCode,
);

export default router;
