import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  searchGuildMembers,
  linkSubAccount,
  getSubAccounts,
  removeSubAccount,
  updateMemberStatus,
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
  */
  validateRequest(linkSubAccountSchema),
  linkSubAccount,
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
 */
router.put(
  '/status',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '멤버 상태 변경'
    #swagger.description = '멤버와 연결된 부계정의 상태를 일괄 변경합니다. (1: 활동, 2: 탈퇴)'
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
  validateRequest(updateMemberStatusSchema),
  updateMemberStatus,
);

/**
 * @route DELETE /api/guildMember/sub-account
 * @desc 부계정 연결 해제 (Hard Delete)
 */
router.delete(
  '/sub-account',
  /* #swagger.tags = ['GuildMember']
    #swagger.summary = '부계정 연결 해제'
    #swagger.description = '부계정이 본계정과의 연결을 해제합니다.'
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
  validateRequest(removeSubAccountSchema),
  removeSubAccount,
);

export default router;
