import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireGuildRole } from '../middlewares/requireRole.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { issueCodes, listCodes, getNextCode } from '../controllers/tournament.controller.js';

const router: Router = Router();

// --- Schemas ---

// Buffer의 base64 디코딩은 잘못된 입력에도 예외 없이 깨진 문자열을 돌려준다.
// 봇·admin은 권한 검사를 건너뛰므로 여기서 막지 않으면 깨진 guildId로 Riot 코드가 실제로 발급된다.
const guildParams = z.object({
  guildId: z.string().regex(/^\d{17,20}$/, 'guildId must be a Base64-encoded Discord guild id'),
});

const issueCodesSchema = z.object({
  params: guildParams,
  body: z.object({
    // 봇 발급 시에만 필요(다음 코드 게시 채널). 웹 발급은 생략.
    channelId: z.string().min(1).max(128).optional(),
    count: z
      // 값이 없을 때는 undefined를 반환해 zod 기본 문구로 넘긴다
      .number({
        error: (issue) => (issue.input === undefined ? undefined : 'count must be a number'),
      })
      .int()
      .min(1, 'count must be 1 or greater')
      .max(50, 'count must be 50 or less'),
    // 경기 유형. 생략 시 서비스에서 '1'(일반내전) 적용.
    gameType: z
      .enum(['1', '2', '3', '4'], {
        error: '게임 타입은 1(일반내전)/2(스크림)/3(예선)/4(본선) 중 하나여야 합니다.',
      })
      .optional(),
    spectatorType: z
      .enum(['ALL', 'LOBBYONLY', 'NONE'], {
        error: '관전 설정은 ALL/LOBBYONLY/NONE 중 하나여야 합니다.',
      })
      .optional(),
  }),
});

const listCodesSchema = z.object({
  params: guildParams,
  query: z.object({
    status: z
      .enum(['PENDING', 'COMPLETED', 'INVALID'], {
        error: '상태는 PENDING/COMPLETED/INVALID 중 하나여야 합니다.',
      })
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1, 'limit must be 1 or greater')
      .max(100, 'limit must be 100 or less')
      .default(50),
  }),
});

const nextCodeSchema = z.object({
  params: guildParams,
});

const manager = requireGuildRole('guildManager', { from: 'params', key: 'guildId' });
const member = requireGuildRole('userNormal', { from: 'params', key: 'guildId' });

// --- Routes ---
// requireGuildRole이 디코딩된 guildId로 권한을 보므로 decodeGuildIdMiddleware가 항상 먼저다.

/**
 * @route POST /api/tournament/:guildId/codes
 * @desc 토너먼트 코드 발급 (봇/웹 공용). 기존 인증 체인(restrictBotToLocalhost, verifyAuth) 아래 구역.
 * @access 봇은 requireGuildRole 바이패스, 웹 세션은 guildManager 이상 (admin bypass)
 */
router.post(
  '/:guildId/codes',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '토너먼트 코드 발급 (봇/웹 공용)'
    #swagger.description = 'count개 코드를 선발급하여 tournament_code(PENDING)로 저장합니다. 봇 발급은 channelId가 metadata에 저장되어 콜백 시 다음 코드 게시 대상이 되고, 웹 발급(guildManager 이상)은 channelId 없이 발급자(issuedBy)가 기록됩니다. gameType은 1(일반내전)/2(스크림)/3(예선)/4(본선), 생략 시 1 — 코드 행에 기록됩니다(적재는 match_v5_raw 원본 저장만 — MVP raw-only). spectatorType은 ALL(전체 허용)/LOBBYONLY(로비에서만)/NONE(관전 불가), 생략 시 ALL. guildId는 Base64.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { count: 3, gameType: '1', spectatorType: 'ALL', channelId: '456' }
    }
    #swagger.responses[201] = {
      description: '발급 성공',
      schema: {
        status: 'success',
        message: 'Tournament codes issued successfully',
        data: { codes: [{ code: 'KR05130-1f8e2c4a-7b3d-4e9a-a6c1-2d5f80e9b713', guildId: '987654321098765432', channelId: null, source: 'WEB', gameType: '1', spectatorType: 'ALL', status: 'PENDING', issuedDate: '2026-11-24T11:02:00.000Z', usedDate: null }] }
      }
    }
    #swagger.security = [{ "session": [] }]
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(issueCodesSchema),
  issueCodes,
);

/**
 * @route GET /api/tournament/:guildId/codes
 * @desc 발급한 코드 목록 (최신 발급 먼저).
 * @access 봇은 requireGuildRole 바이패스, 웹 세션은 길드 멤버(userNormal) 이상 (admin bypass)
 */
router.get(
  '/:guildId/codes',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '발급한 토너먼트 코드 목록'
    #swagger.description = '길드가 발급한 코드를 issued_date 내림차순으로 반환합니다. status(PENDING=대기/COMPLETED=기록 완료/INVALID=만료)로 거를 수 있고, limit은 1~100(기본 50). 과거에 관전 설정 없이 발급된 코드는 spectatorType ALL로 표시됩니다. 길드 멤버(userNormal) 이상이면 조회할 수 있습니다. guildId는 Base64.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['status'] = { in: 'query', type: 'string', enum: ['PENDING', 'COMPLETED', 'INVALID'] }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: '1~100, 기본 50' }
    #swagger.responses[200] = {
      description: '조회 성공',
      schema: {
        status: 'success',
        message: 'Tournament codes retrieved successfully',
        data: { codes: [{ code: 'KR05130-1f8e2c4a-7b3d-4e9a-a6c1-2d5f80e9b713', guildId: '987654321098765432', channelId: null, source: 'WEB', gameType: '1', spectatorType: 'ALL', status: 'COMPLETED', issuedDate: '2026-11-24T11:02:00.000Z', usedDate: '2026-11-24T11:41:00.000Z' }] }
      }
    }
    #swagger.security = [{ "session": [] }]
  */
  decodeGuildIdMiddleware,
  member,
  validateRequest(listCodesSchema),
  listCodes,
);

/**
 * @route GET /api/tournament/:guildId/next-code
 * @desc 미사용 다음 코드 조회.
 */
router.get(
  '/:guildId/next-code',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = '미사용 다음 코드 조회'
    #swagger.description = 'PENDING 코드 중 issued_date 오름차순 첫 코드를 반환합니다. 없으면 404. guildId는 Base64.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
  */
  decodeGuildIdMiddleware,
  validateRequest(nextCodeSchema),
  getNextCode,
);

export default router;
