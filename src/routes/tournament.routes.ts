import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireGuildRole } from '../middlewares/requireRole.js';
import { issueCodes, getNextCode } from '../controllers/tournament.controller.js';

const router: Router = Router();

// --- Schemas ---

const issueCodesSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'guildId is required').max(128),
    // 봇 발급 시에만 필요(다음 코드 게시 채널). 웹 발급은 생략.
    channelId: z.string().min(1).max(128).optional(),
    count: z
      .number({ invalid_type_error: 'count must be a number' })
      .int()
      .min(1, 'count must be 1 or greater')
      .max(50, 'count must be 50 or less'),
    // 경기 유형. 생략 시 서비스에서 '1'(일반내전) 적용.
    gameType: z
      .enum(['1', '2', '3'], {
        errorMap: () => ({ message: '게임 타입은 1(일반내전)/2(스크림)/3(대회) 중 하나여야 합니다.' }),
      })
      .optional(),
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
 * @desc 토너먼트 코드 발급 (봇/웹 공용). 기존 인증 체인(restrictBotToLocalhost, verifyAuth) 아래 구역.
 * @access 봇은 requireGuildRole 바이패스, 웹 세션은 guildManager 이상 (admin bypass)
 */
router.post(
  '/codes',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '토너먼트 코드 발급 (봇/웹 공용)'
    #swagger.description = 'count개 코드를 선발급하여 tournament_code(PENDING)로 저장합니다. 봇 발급은 channelId가 metadata에 저장되어 콜백 시 다음 코드 게시 대상이 되고, 웹 발급(guildManager 이상)은 channelId 없이 발급자(issuedBy)가 기록됩니다. gameType은 1(일반내전)/2(스크림)/3(대회), 생략 시 1 — 코드 행에 기록됩니다(적재는 match_v5_raw 원본 저장만 — MVP raw-only).'
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { guildId: '123', channelId: '456', count: 3, gameType: '1' }
    }
    #swagger.security = [{ "session": [] }]
  */
  requireGuildRole('guildManager', { from: 'body', key: 'guildId' }),
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
