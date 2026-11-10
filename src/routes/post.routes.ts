import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { getPost, listPosts } from '../controllers/post.controller.js';
import { POST_CATEGORIES, POST_CONTENT_MAX, POST_TITLE_MAX } from '../types/post.js';

const INT4_MAX = 2_147_483_647;

const numericString = (max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'Must be a positive number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));

export const postListSchema = z.object({
  query: z.object({
    category: z.enum(POST_CATEGORIES).optional(),
    page: numericString(INT4_MAX).optional(),
    limit: numericString(100).optional(),
  }),
});

export const postIdSchema = z.object({
  params: z.object({ id: numericString(INT4_MAX) }),
});

const title = z.string().trim().min(1, 'title is required').max(POST_TITLE_MAX);
const content = z
  .string()
  .max(POST_CONTENT_MAX)
  .refine((value) => value.trim() !== '', 'content is required');
const sortOrder = z.number().int().min(0).max(INT4_MAX).nullable();

export const postCreateSchema = z.object({
  body: z.object({
    category: z.enum(POST_CATEGORIES),
    title,
    content,
    isPublished: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  }),
});

export const postUpdateSchema = z.object({
  params: postIdSchema.shape.params,
  body: z
    .object({
      category: z.enum(POST_CATEGORIES).optional(),
      title: title.optional(),
      content: content.optional(),
      isPublished: z.boolean().optional(),
      sortOrder: sortOrder.optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'At least one field is required'),
});

const router: Router = Router();

/**
 * @route GET /api/posts
 * @desc 공개된 게시판 글 목록 (비로그인 허용)
 */
router.get(
  '/',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 목록'
    #swagger.description = '세션 없이 공개된 글만 조회합니다. devlog·etc는 처음 공개한 시각 최신순, faq·guide는 sortOrder 오름차순입니다. category를 생략하면 전체를 최신순으로 반환합니다. 본문(content)은 category=faq일 때만 포함합니다. 페이지 정보는 X-Total-Count·X-Page·X-Limit·X-Total-Pages 헤더로 내려갑니다.'
    #swagger.security = []
    #swagger.parameters['category'] = { in: 'query', type: 'string', enum: ['devlog', 'faq', 'guide', 'etc'], description: '카테고리 (생략 시 전체)' }
    #swagger.parameters['page'] = { in: 'query', type: 'integer', minimum: 1, default: 1, description: '페이지 번호' }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', minimum: 1, maximum: 100, default: 20, description: '한 페이지당 개수' }
    #swagger.responses[200] = {
      description: '조회 성공',
      schema: {
        status: 'success',
        message: 'Posts retrieved successfully',
        data: [
          { id: 3, category: 'faq', title: '리플 업로드가 안 돼요', content: '마크다운 원문', sortOrder: 1, publishDate: '2026-11-10T09:00:00.000Z' }
        ]
      }
    }
  */
  validateRequest(postListSchema),
  listPosts,
);

/**
 * @route GET /api/posts/:id
 * @desc 공개된 게시판 글 상세 (비로그인 허용)
 */
router.get(
  '/:id',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 상세'
    #swagger.description = '세션 없이 공개된 글을 조회합니다. 초안·삭제된 글은 404입니다. content는 마크다운 원문이며, 프론트는 raw HTML을 렌더링하지 않아야 합니다.'
    #swagger.security = []
    #swagger.responses[200] = {
      description: '조회 성공',
      schema: {
        status: 'success',
        message: 'Post retrieved successfully',
        data: { id: 1, category: 'devlog', title: '11월 업데이트', content: '마크다운 원문', sortOrder: null, publishDate: '2026-11-10T09:00:00.000Z', updateDate: '2026-11-10T09:00:00.000Z' }
      }
    }
    #swagger.responses[404] = { description: '없거나 공개되지 않은 글', schema: { status: 'error', message: 'Post not found', data: null } }
  */
  validateRequest(postIdSchema),
  getPost,
);

export default router;
