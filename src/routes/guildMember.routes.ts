import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireGuildRole } from '../middlewares/requireRole.js';
import {
  searchGuildMembers,
  linkSubAccount,
  getSubAccounts,
  removeSubAccount,
  updateMemberStatus,
  getMembers,
  getGuildDiscordMembers,
  updateGuildMemberRole,
} from '../controllers/guildMember.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';

const router: Router = Router();

// --- Define Zod schemas for validation ---

const searchGuildMembersSchema = z.object({
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
      .min(1, 'riotNameTag is required')
      .max(128, 'Search term must be less than 128 characters')
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'Limit must be a positive number')
      .transform(Number)
      .optional(),
  }),
});

const linkSubAccountSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    subRiotName: z.string().min(1, 'Sub Riot Name is required').max(128),
    subRiotTag: z.string().min(1, 'Sub Riot Tag is required').max(128),
    mainRiotName: z.string().min(1, 'Main Riot Name is required').max(128),
    mainRiotTag: z.string().min(1, 'Main Riot Tag is required').max(128),
  }),
});

const getSubAccountsSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const getMembersSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
  }),
  query: z.object({
    status: z.enum(['1', '2', 'all']).optional().default('1'),
    page: z.string().regex(/^\d+$/, 'Page must be a positive number').transform(Number).optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'Limit must be a positive number')
      .transform(Number)
      .optional(),
  }),
});

const getDiscordMembersSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
  }),
  query: z.object({
    search: z.string().max(128, 'Search term must be less than 128 characters').optional(),
    // validateRequest는 transform 결과를 컨트롤러로 전달하지 않으므로(원본 req 유지),
    // 상한 검증을 여기서 걸고 컨트롤러에서도 클램프한다. 무제한 값은 bigint 파싱 500/테이블 덤프 유발.
    page: z
      .string()
      .regex(/^\d+$/, 'Page must be a positive number')
      .refine((v) => Number(v) >= 1 && Number(v) <= 100000, 'Page must be between 1 and 100000')
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'Limit must be a positive number')
      .refine((v) => Number(v) >= 1 && Number(v) <= 100, 'Limit must be between 1 and 100')
      .optional(),
  }),
});

const updateMemberRoleSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    memberId: z.string().min(1, 'Member ID is required').max(64),
  }),
  body: z.object({
    role: z.enum(['userNormal', 'userUploader'], {
      errorMap: () => ({ message: "Role must be 'userNormal' or 'userUploader'" }),
    }),
  }),
});

const removeSubAccountSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    riotName: z.string().min(1, 'Riot Name is required').max(128),
    riotNameTag: z.string().min(1, 'Riot Tag is required').max(128),
  }),
});

const updateMemberStatusSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    riotName: z.string().min(1, 'Riot Name is required').max(128),
    riotNameTag: z.string().min(1, 'Riot Tag is required').max(128),
    status: z.enum(['1', '2'], {
      errorMap: () => ({ message: "Status must be '1' (Active) or '2' (Withdrawn)" }),
    }),
  }),
});

// --- Define Routes ---

/**
 * @route POST /api/guildMember/sub-account
 * @desc 부계정을 본계정에 연결하고 DB 정보 업데이트 (트랜잭션 포함)
 */
router.post(
  '/sub-account',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '부계정 연결'
    #swagger.description = '본계정에 부계정을 연결합니다.'
    #swagger.parameters['body'] = {
      in: 'body',
      description: '연결할 계정 정보',
      required: true,
      schema: {
        guildId: 'string',
        subRiotName: 'SubName',
        subRiotTag: 'KR1',
        mainRiotName: 'MainName',
        mainRiotTag: 'KR1'
      }
    }
    #swagger.security = [{ "session": [] }]
  */
  requireGuildRole('guildManager', { from: 'body', key: 'guildId' }),
  validateRequest(linkSubAccountSchema),
  linkSubAccount,
);

/**
 * @route GET /api/guildMember/:guildId/members
 * @desc 길드 멤버 목록 조회 (status: 1=활성, 2=탈퇴, all=전체)
 */
router.get(
  '/:guildId/members',
  /* #swagger.auto = false
    #swagger.tags = ['GuildMember']
    #swagger.summary = '멤버 목록 조회'
    #swagger.description = '길드 멤버 목록을 조회합니다. status=1(활성, 기본값), status=2(탈퇴), status=all(전체)'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID', required: true, type: 'string' }
    #swagger.parameters['status'] = { in: 'query', description: '1: 활성 (기본값), 2: 탈퇴, all: 전체', type: 'string', enum: ['1', '2', 'all'] }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수 (기본값: 50)', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(getMembersSchema),
  getMembers,
);

/**
 * @route GET /api/guildMember/:guildId/sub-accounts
 * @desc 특정 길드의 부계정 목록 조회
 */
router.get(
  '/:guildId/sub-accounts',
  /* #swagger.auto = false
    #swagger.tags = ['GuildMember']
    #swagger.summary = '부계정 목록 조회'
    #swagger.description = '특정 길드 내의 연결된 부계정 목록을 조회합니다.'
    
    #swagger.parameters['guildId'] = { 
      in: 'path',
      description: '길드 ID',
      required: true,
      type: 'string'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(getSubAccountsSchema),
  getSubAccounts,
);

/**
 * @route GET /api/guildMember/:guildId/discord-members
 * @desc 멤버 관리 화면용 Discord 멤버 목록/검색 (길드 스코프 역할 포함)
 * @access guildManager 이상 (admin bypass)
 * @note /:guildId/:riotName 보다 먼저 등록해야 riotName으로 잡히지 않음
 */
router.get(
  '/:guildId/discord-members',
  /* #swagger.auto = false
    #swagger.tags = ['GuildMember']
    #swagger.summary = 'Discord 멤버 목록/검색 (권한 관리)'
    #swagger.description = 'guildManager가 관리할 Discord 멤버 목록을 조회합니다. 웹 로그인 이력이 있는 멤버만 표시. (guildManager 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['search'] = { in: 'query', description: '표시명 부분 검색', type: 'string' }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수 (기본값: 50)', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  requireGuildRole('guildManager', { from: 'params', key: 'guildId' }),
  validateRequest(getDiscordMembersSchema),
  getGuildDiscordMembers,
);

/**
 * @route PATCH /api/guildMember/:guildId/discord-members/:memberId/role
 * @desc 멤버 역할 부여/회수 (userNormal <-> userUploader)
 * @access guildManager 이상 (admin bypass)
 */
router.patch(
  '/:guildId/discord-members/:memberId/role',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '멤버 역할 부여/회수'
    #swagger.description = 'guildManager가 대상 멤버의 역할을 userNormal <-> userUploader로 변경합니다. guildManager 이상 대상은 변경 불가. (guildManager 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['memberId'] = { in: 'path', description: '대상 Discord 멤버 ID', required: true, type: 'string' }
    #swagger.parameters['body'] = {
      in: 'body',
      description: '변경할 역할',
      required: true,
      schema: { role: 'userUploader' }
    }
  */
  decodeGuildIdMiddleware,
  requireGuildRole('guildManager', { from: 'params', key: 'guildId' }),
  validateRequest(updateMemberRoleSchema),
  updateGuildMemberRole,
);

/**
 * @route GET /api/guildMember/:guildId/:riotName
 * @desc 쿼리 파라미터로 길드 ID와 Riot ID를 받아 멤버 검색
 * @access Public
 */
router.get(
  '/:guildId/:riotName',
  /* #swagger.auto = false
    #swagger.tags = ['GuildMember']
    #swagger.summary = '길드 멤버 검색'
    #swagger.description = '길드 ID, Riot Name, Tag를 조합하여 멤버를 검색합니다.'
    
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
    #swagger.parameters['limit'] = { in: 'query', description: '조회 개수 제한', type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(searchGuildMembersSchema),
  searchGuildMembers,
);

/**
 * @route PUT /api/guildMember/status
 * @desc 길드 멤버 상태 변경 (활동 1 / 탈퇴 2) - 부캐 포함 일괄 처리
 * @access guildManager 이상 (admin bypass)
 */
router.put(
  '/status',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '멤버 상태 변경'
    #swagger.description = '멤버와 연결된 부계정의 상태를 일괄 변경합니다. (1: 활동, 2: 탈퇴) (guildManager 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      description: '상태 변경 정보',
      required: true,
      schema: {
        guildId: 'string',
        riotName: 'string',
        riotNameTag: 'string',
        status: '1'
      }
    }
  */
  requireGuildRole('guildManager', { from: 'body', key: 'guildId' }),
  validateRequest(updateMemberStatusSchema),
  updateMemberStatus,
);

/**
 * @route DELETE /api/guildMember/sub-account
 * @desc 부계정 연결 해제 (Hard Delete)
 * @access guildManager 이상 (admin bypass)
 */
router.delete(
  '/sub-account',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '부계정 연결 해제'
    #swagger.description = '부계정이 본계정과의 연결을 해제합니다. (guildManager 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              guildId: { type: "string", example: "string" },
              riotName: { type: "string", example: "string" },
              riotNameTag: { type: "string", example: "string" }
            }
          }
        }
      }
    }
  */
  requireGuildRole('guildManager', { from: 'body', key: 'guildId' }),
  validateRequest(removeSubAccountSchema),
  removeSubAccount,
);

export default router;
