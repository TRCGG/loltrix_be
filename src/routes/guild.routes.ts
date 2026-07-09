import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireAdmin, requireGuildRole } from '../middlewares/requireRole.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import {
  createGuild,
  getGuildById,
  getAllGuilds,
  updateGuild,
  deleteGuild,
  updateAllowAllUploads,
} from '../controllers/guild.controller.js';

const router: Router = Router();

// Define Zod schemas for validation
const createGuildSchema = z.object({
  body: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
    guildName: z
      .string()
      .min(1, 'Guild name is required')
      .max(128, 'Guild name must be less than 128 characters'),
    languageCode: z.string().max(10, 'Language code must be less than 10 characters').optional(),
  }),
});

const updateGuildSchema = z.object({
  body: z.object({
    guildName: z
      .string()
      .min(1, 'Guild name is required')
      .max(128, 'Guild name must be less than 128 characters')
      .optional(),
    languageCode: z.string().max(10, 'Language code must be less than 10 characters').optional(),
    isDeleted: z.boolean().optional(),
  }),
  params: z.object({
    id: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const getGuildByIdSchema = z.object({
  params: z.object({
    id: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const getAllGuildsSchema = z.object({
  query: z
    .object({
      page: z
        .string()
        .regex(/^\d+$/, 'Page must be a positive number')
        .transform(Number)
        .optional(),
      limit: z
        .string()
        .regex(/^\d+$/, 'Limit must be a positive number')
        .transform(Number)
        .optional(),
      search: z.string().max(128, 'Search term must be less than 128 characters').optional(),
    })
    .optional(),
});

const deleteGuildSchema = z.object({
  params: z.object({
    id: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const allowAllUploadsSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
  }),
  body: z.object({
    allowAllUploads: z.boolean({
      required_error: 'allowAllUploads is required',
      invalid_type_error: 'allowAllUploads must be a boolean',
    }),
  }),
});

/**
 * @route POST /api/guilds
 * @desc 새로운 길드 생성
 * @access adminNormal 이상
 */
router.post(
  '/',
  /* #swagger.tags = ['Guild']
    #swagger.summary = '새 길드 생성'
    #swagger.description = '새로운 길드를 등록합니다. (adminNormal 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      description: '길드 정보',
      required: true,
      schema: {
        guildId: '123456',
        guildName: 'My Awesome Guild',
        languageCode: 'ko'
      }
    }
  */
  requireAdmin('adminNormal'),
  validateRequest(createGuildSchema),
  createGuild,
);

/**
 * @route GET /api/guilds/:id
 * @desc Guild ID로 길드 조회
 * @access Public
 */
router.get(
  '/:id',
  /* #swagger.tags = ['Guild']
    #swagger.summary = '길드 상세 조회'
    #swagger.description = '길드 ID를 이용하여 특정 길드의 정보를 조회합니다.'
    #swagger.parameters['id'] = { description: '조회할 Guild ID' }
  */
  validateRequest(getGuildByIdSchema),
  getGuildById,
);

/**
 * @route PUT /api/guilds/:id
 * @desc Guild ID로 길드 수정
 * @access adminNormal 이상
 */
router.put(
  '/:id',
  /* #swagger.tags = ['Guild']
    #swagger.summary = '길드 정보 수정'
    #swagger.description = '길드 이름, 언어 코드, 삭제 여부 등을 수정합니다. (adminNormal 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['id'] = { description: '수정할 Guild ID' }
    #swagger.parameters['body'] = {
      in: 'body',
      description: '수정할 필드 (선택 입력)',
      schema: {
        guildName: 'Updated Name',
        languageCode: 'en',
        isDeleted: false
      }
    }
  */
  requireAdmin('adminNormal'),
  validateRequest(updateGuildSchema),
  updateGuild,
);

/**
 * @route GET /api/guilds
 * @desc 페이지네이션과 검색으로 모든 길드 조회
 * @access Public
 */
router.get(
  '/',
  /* #swagger.tags = ['Guild']
    #swagger.summary = '길드 목록 조회'
    #swagger.description = '검색어, 페이지, 리밋을 사용하여 길드 목록을 조회합니다.'
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호 (기본 1)', type: 'integer' }
    #swagger.parameters['limit'] = { in: 'query', description: '한 페이지당 개수 (기본 10)', type: 'integer' }
    #swagger.parameters['search'] = { in: 'query', description: '길드명 검색어', type: 'string' }
  */
  validateRequest(getAllGuildsSchema),
  getAllGuilds,
);

/**
 * @route DELETE /api/guilds/:id
 * @desc Guild ID로 길드 삭제 (소프트 삭제)
 * @access adminNormal 이상
 */
router.delete(
  '/:id',
  /* #swagger.tags = ['Guild']
    #swagger.summary = '길드 삭제'
    #swagger.description = '길드 ID를 이용하여 길드를 소프트 삭제(isDeleted=true) 처리합니다. (adminNormal 이상 권한 필요)'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['id'] = { description: '삭제할 Guild ID' }
  */
  requireAdmin('adminNormal'),
  validateRequest(deleteGuildSchema),
  deleteGuild,
);

/**
 * @route PATCH /api/guilds/:guildId/allow-all-uploads
 * @desc allowAllUploads(전체 업로드 허용) 플래그만 토글
 * @access guildManager 이상 (admin bypass)
 * @note 기존 PUT /api/guilds/:id(adminNormal)를 넓히지 않고 이 플래그 전용으로 신설
 */
router.patch(
  '/:guildId/allow-all-uploads',
  /* #swagger.auto = false
    #swagger.tags = ['Guild']
    #swagger.summary = 'allowAllUploads 토글'
    #swagger.description = '[길드 설정: 전체 멤버 업로드 허용 스위치]. ▶ body.allowAllUploads에 원하는 최종 상태(true/false)를 보냅니다. ▶ true면 개별 uploader 권한과 무관하게 모든 멤버가 업로드 가능. ▶ 응답 data는 변경된 길드 객체(allowAllUploads 포함)이니 스위치 상태를 이 값으로 갱신하세요. ▶ guildId는 Base64. ▶ 세션 로그인(guildManager 이상) 필요.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['body'] = {
      in: 'body',
      description: '전체 업로드 허용 여부',
      required: true,
      schema: { allowAllUploads: true }
    }
    #swagger.responses[200] = {
      description: '변경 성공',
      schema: {
        status: 'success',
        message: 'allowAllUploads updated successfully',
        data: {
          id: '987654321098765432',
          name: '내 길드',
          languageCode: 'ko',
          allowAllUploads: true,
          createDate: '2026-01-15T09:00:00.000Z',
          updateDate: '2026-07-03T12:34:56.000Z',
          isDeleted: false
        }
      }
    }
    #swagger.responses[400] = { description: 'allowAllUploads 누락 또는 boolean 아님', schema: { status: 'error', message: 'allowAllUploads must be a boolean', data: null } }
    #swagger.responses[401] = { description: '미인증 (세션 없음)', schema: { status: 'error', message: 'Unauthorized', data: null } }
    #swagger.responses[403] = { description: 'guildManager 미만 권한', schema: { status: 'error', message: 'Forbidden: insufficient guild role', data: null } }
    #swagger.responses[404] = { description: '길드 없음 또는 이미 삭제됨', schema: { status: 'error', message: 'Guild not found or already deleted', data: null } }
  */
  decodeGuildIdMiddleware,
  requireGuildRole('guildManager', { from: 'params', key: 'guildId' }),
  validateRequest(allowAllUploadsSchema),
  updateAllowAllUploads,
);

export default router;
