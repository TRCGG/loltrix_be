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
  getGuildAuditLogs,
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
      .refine((v) => Number(v) >= 1 && Number(v) <= 1000, 'Limit must be between 1 and 1000')
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

const getAuditLogsSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
  }),
  query: z.object({
    type: z.enum(['all', 'roleChange', 'replayDelete']).optional(),
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
    #swagger.description = '[멤버 권한 관리 화면] 목록/검색용. 웹에 로그인한 적 있는 Discord 멤버만 반환합니다. 각 항목의 role로 현재 권한을 표시하세요. ▶ guildId는 Base64 인코딩해 path에 넣습니다. ▶ 페이지네이션(총 개수/현재 페이지/전체 페이지)은 응답 body가 아니라 응답 헤더 X-Total-Count / X-Page / X-Limit / X-Total-Pages 로 옵니다. ▶ search는 표시명 부분검색(선택). ▶ 세션 로그인(guildManager 이상) 필요.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['search'] = { in: 'query', description: '표시명 부분 검색', type: 'string' }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호 (1~100000, 기본값 1)', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수 (1~1000, 기본값 50)', type: 'integer' }
    #swagger.responses[200] = {
      description: '조회 성공. 페이지네이션 정보는 응답 헤더(X-Total-Count, X-Page, X-Limit, X-Total-Pages)로 전달됩니다. displayName = 길드 별명 ?? 전역 별명 ?? discord_id',
      schema: {
        status: 'success',
        message: 'Discord members retrieved successfully',
        data: [
          { memberId: '123456789012345678', displayName: '홍길동', role: 'userUploader' },
          { memberId: '234567890123456789', displayName: '김철수', role: 'userNormal' }
        ]
      }
    }
    #swagger.responses[401] = { description: '미인증 (세션 없음)', schema: { status: 'error', message: 'Unauthorized', data: null } }
    #swagger.responses[403] = { description: 'guildManager 미만 권한', schema: { status: 'error', message: 'Forbidden: insufficient guild role', data: null } }
  */
  decodeGuildIdMiddleware,
  requireGuildRole('guildManager', { from: 'params', key: 'guildId' }),
  validateRequest(getDiscordMembersSchema),
  getGuildDiscordMembers,
);

/**
 * @route GET /api/guildMember/:guildId/audit-logs
 * @desc 클랜관리 관리 로그 조회 (역할 부여/회수 + 리플 삭제 통합, 최신순)
 * @access guildManager 이상 (admin bypass)
 * @note /:guildId/:riotName 보다 먼저 등록해야 riotName으로 잡히지 않음
 */
router.get(
  '/:guildId/audit-logs',
  /* #swagger.auto = false
    #swagger.tags = ['GuildMember']
    #swagger.summary = '관리 로그 조회 (역할 변경 + 리플 삭제)'
    #swagger.description = '[클랜관리 화면] 관리 로그 목록용. 역할 부여/회수 이력과 리플(게임 기록) 삭제 이력을 하나의 시간순(최신순) 피드로 반환합니다. ▶ 항목의 type으로 구분: roleChange(역할 변경 — targetMemberId/fromRole/toRole 사용), replayDelete(리플 삭제 — gameId/source 사용, 나머지는 null). ▶ source는 삭제 경로: web(웹 화면) / bot(디스코드 !drop). ▶ actorDisplayName/targetDisplayName은 길드 별명 ?? 전역 별명 ?? discord_id로 해석된 표시명이며, 웹 로그인 이력이 없는 봇 명령 사용자는 discord_id 그대로 나올 수 있습니다. actorMemberId가 \\'bot\\'이면 구버전 봇 요청이라 삭제자 미상입니다. ▶ 페이지네이션은 응답 헤더 X-Total-Count / X-Page / X-Limit / X-Total-Pages. ▶ type 쿼리로 필터 가능(all 기본). ▶ guildId는 Base64. ▶ 세션 로그인(guildManager 이상) 필요.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['type'] = { in: 'query', description: '로그 종류 필터 (all 기본)', type: 'string', enum: ['all', 'roleChange', 'replayDelete'] }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호 (1~100000, 기본값 1)', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '페이지당 개수 (1~100, 기본값 50)', type: 'integer' }
    #swagger.responses[200] = {
      description: '조회 성공. 페이지네이션 정보는 응답 헤더(X-Total-Count, X-Page, X-Limit, X-Total-Pages)로 전달됩니다.',
      schema: {
        status: 'success',
        message: 'Audit logs retrieved successfully',
        data: [
          { type: 'replayDelete', createDate: '2026-07-11T12:34:56.000Z', actorMemberId: '123456789012345678', actorDisplayName: '홍길동', targetMemberId: null, targetDisplayName: null, fromRole: null, toRole: null, gameId: 'RPY-20260205-xxxxxx-001', source: 'bot' },
          { type: 'roleChange', createDate: '2026-07-10T09:00:00.000Z', actorMemberId: '123456789012345678', actorDisplayName: '홍길동', targetMemberId: '234567890123456789', targetDisplayName: '김철수', fromRole: 'userNormal', toRole: 'userUploader', gameId: null, source: null }
        ]
      }
    }
    #swagger.responses[401] = { description: '미인증 (세션 없음)', schema: { status: 'error', message: 'Unauthorized', data: null } }
    #swagger.responses[403] = { description: 'guildManager 미만 권한', schema: { status: 'error', message: 'Forbidden: insufficient guild role', data: null } }
  */
  decodeGuildIdMiddleware,
  requireGuildRole('guildManager', { from: 'params', key: 'guildId' }),
  validateRequest(getAuditLogsSchema),
  getGuildAuditLogs,
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
    #swagger.description = '[업로더 권한 부여/회수 버튼]에 연결. ▶ body.role에 원하는 최종 상태를 그대로 보냅니다 — userUploader=권한 부여, userNormal=권한 회수 (토글이 아니라 원하는 값 지정). ▶ 이미 그 역할이면 에러가 아니라 200 + data.changed=false 로 응답하니 UI에서 그대로 반영하면 됩니다. ▶ 대상이 guildManager 이상이면 403, 웹 로그인 이력 없는 멤버면 404. ▶ guildId는 Base64. ▶ 세션 로그인(guildManager 이상) 필요.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['memberId'] = { in: 'path', description: '대상 Discord 멤버 ID', required: true, type: 'string' }
    #swagger.parameters['body'] = {
      in: 'body',
      description: "변경할 역할 (userNormal: 회수 / userUploader: 부여)",
      required: true,
      schema: { role: 'userUploader' }
    }
    #swagger.responses[200] = {
      description: '변경 성공. 이미 같은 역할이면 변경 없이 changed:false로 응답합니다(idempotent).',
      schema: {
        status: 'success',
        message: 'Role updated to userUploader',
        data: { memberId: '234567890123456789', guildId: '987654321098765432', role: 'userUploader', changed: true }
      }
    }
    #swagger.responses[400] = { description: 'role 값이 userNormal/userUploader가 아님', schema: { status: 'error', message: "Role must be 'userNormal' or 'userUploader'", data: null } }
    #swagger.responses[401] = { description: '미인증 (세션 없음)', schema: { status: 'error', message: 'Unauthorized', data: null } }
    #swagger.responses[403] = { description: 'guildManager 미만 권한이거나, 대상이 guildManager 이상이라 변경 불가', schema: { status: 'error', message: 'Cannot modify guildManager or higher role', data: null } }
    #swagger.responses[404] = { description: '대상 멤버가 이 길드에 없음 (웹 로그인 이력 필요)', schema: { status: 'error', message: 'Target member not found in this guild (web login history required)', data: null } }
    #swagger.responses[409] = { description: '대상의 현재 역할이 관리 불가한 미지의 값', schema: { status: 'error', message: 'Cannot modify unknown role: someRole', data: null } }
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
