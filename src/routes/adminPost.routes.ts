import { NextFunction, Response, Router } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { requireAdmin } from '../middlewares/requireRole.js';
import {
  createPost,
  deletePost,
  getAdminPost,
  listAdminPosts,
  updatePost,
} from '../controllers/post.controller.js';
import { postCreateSchema, postIdSchema, postListSchema, postUpdateSchema } from './post.routes.js';

const router: Router = Router();

// requireAdmin은 봇 요청을 그대로 통과시키므로(다른 라우트가 기대하는 동작) 여기서 먼저 끊는다.
const rejectBot = (req: AuthRequest, res: Response, next: NextFunction) => {
  if (req.isBot) {
    return res
      .status(403)
      .json({ status: 'error', message: 'Bot cannot manage posts', data: null });
  }
  return next();
};

router.use(rejectBot, requireAdmin('adminNormal'));

/**
 * @route GET /api/admin/posts
 * @desc 게시판 글 관리 목록 (초안 포함)
 * @access adminNormal 이상
 */
router.get(
  '/',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 관리 목록'
    #swagger.description = '초안을 포함해 조회합니다 (adminNormal 이상). 정렬·본문 포함 규칙은 공개 목록과 같고, 초안은 최신순 카테고리에서 맨 위에 옵니다. isPublished·updateDate가 추가됩니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.parameters['category'] = { in: 'query', type: 'string', enum: ['devlog', 'faq', 'guide', 'etc'], description: '카테고리 (생략 시 전체)' }
    #swagger.parameters['page'] = { in: 'query', type: 'integer', minimum: 1, default: 1 }
    #swagger.parameters['limit'] = { in: 'query', type: 'integer', minimum: 1, maximum: 100, default: 20 }
    #swagger.responses[403] = { description: 'admin 권한 없음' }
  */
  validateRequest(postListSchema),
  listAdminPosts,
);

/**
 * @route GET /api/admin/posts/:id
 * @desc 게시판 글 관리 상세 (초안 포함)
 * @access adminNormal 이상
 */
router.get(
  '/:id',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 관리 상세'
    #swagger.description = '초안을 포함해 조회합니다 (adminNormal 이상). 삭제된 글은 404입니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.responses[404] = { description: '없거나 삭제된 글', schema: { status: 'error', message: 'Post not found', data: null } }
  */
  validateRequest(postIdSchema),
  getAdminPost,
);

/**
 * @route POST /api/admin/posts
 * @desc 게시판 글 작성
 * @access adminNormal 이상
 */
router.post(
  '/',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 작성'
    #swagger.description = '글을 작성합니다 (adminNormal 이상). isPublished를 생략하면 초안으로 저장합니다. sortOrder는 faq·guide의 노출 순서입니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { category: 'faq', title: '리플 업로드가 안 돼요', content: '마크다운 원문 (최대 10,000자)', isPublished: false, sortOrder: 1 }
    }
    #swagger.responses[201] = { description: '작성 성공' }
  */
  validateRequest(postCreateSchema),
  createPost,
);

/**
 * @route PATCH /api/admin/posts/:id
 * @desc 게시판 글 수정·공개 전환
 * @access adminNormal 이상
 */
router.patch(
  '/:id',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 수정'
    #swagger.description = '보낸 필드만 수정합니다 (adminNormal 이상). isPublished=true로 처음 공개할 때 publishDate가 찍히고, 이후 공개를 내렸다 올려도 바뀌지 않습니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { title: '수정한 제목', isPublished: true }
    }
    #swagger.responses[404] = { description: '없거나 삭제된 글', schema: { status: 'error', message: 'Post not found', data: null } }
  */
  validateRequest(postUpdateSchema),
  updatePost,
);

/**
 * @route DELETE /api/admin/posts/:id
 * @desc 게시판 글 삭제 (soft delete)
 * @access adminNormal 이상
 */
router.delete(
  '/:id',
  /* #swagger.tags = ['Post']
    #swagger.summary = '게시판 글 삭제'
    #swagger.description = 'is_deleted로 숨깁니다 (adminNormal 이상). 복구 API는 없습니다.'
    #swagger.security = [{ "cookieAuth": [] }]
    #swagger.responses[404] = { description: '없거나 이미 삭제된 글', schema: { status: 'error', message: 'Post not found', data: null } }
  */
  validateRequest(postIdSchema),
  deletePost,
);

export default router;
