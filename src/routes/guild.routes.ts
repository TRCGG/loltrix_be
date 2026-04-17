import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireAdmin } from '../middlewares/requireRole.js';
import {
  createGuild,
  getGuildById,
  getAllGuilds,
  updateGuild,
  deleteGuild,
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

export default router;
