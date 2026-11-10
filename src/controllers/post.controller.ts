import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { postService } from '../services/post.service.js';
import {
  AdminPostDetail,
  AdminPostListItem,
  PostCategory,
  PostCreateInput,
  PostDetail,
  PostListItem,
  PostListQuery,
  PostResponse,
  PostUpdateInput,
} from '../types/post.js';

const DEFAULT_LIMIT = 20;

const listQuery = (req: AuthRequest): PostListQuery => {
  const { category, page, limit } = req.query as unknown as {
    category?: PostCategory;
    page?: number;
    limit?: number;
  };
  return { category, page: page ?? 1, limit: limit ?? DEFAULT_LIMIT };
};

const setPagination = (res: Response, totalCount: number, { page, limit }: PostListQuery) => {
  res.setHeader('X-Total-Count', totalCount.toString());
  res.setHeader('X-Page', page.toString());
  res.setHeader('X-Limit', limit.toString());
  res.setHeader('X-Total-Pages', Math.ceil(totalCount / limit).toString());
};

const postId = (req: AuthRequest) => (req.params as unknown as { id: number }).id;

const notFound = <T>(res: Response<PostResponse<T>>) =>
  res.status(404).json({ status: 'error', message: 'Post not found', data: null });

/**
 * @desc 공개 글 목록 조회
 * @route GET /api/posts
 * @access 비로그인 허용
 */
export const listPosts = async (
  req: AuthRequest,
  res: Response<PostResponse<PostListItem[]>>,
  next: NextFunction,
) => {
  try {
    const query = listQuery(req);
    const { items, totalCount } = await postService.listPublished(query);
    setPagination(res, totalCount, query);
    return res
      .status(200)
      .json({ status: 'success', message: 'Posts retrieved successfully', data: items });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 공개 글 상세 조회
 * @route GET /api/posts/:id
 * @access 비로그인 허용
 */
export const getPost = async (
  req: AuthRequest,
  res: Response<PostResponse<PostDetail>>,
  next: NextFunction,
) => {
  try {
    const data = await postService.getPublished(postId(req));
    if (!data) return notFound(res);
    return res
      .status(200)
      .json({ status: 'success', message: 'Post retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 관리용 글 목록 조회 (초안 포함)
 * @route GET /api/admin/posts
 * @access adminNormal 이상
 */
export const listAdminPosts = async (
  req: AuthRequest,
  res: Response<PostResponse<AdminPostListItem[]>>,
  next: NextFunction,
) => {
  try {
    const query = listQuery(req);
    const { items, totalCount } = await postService.listForAdmin(query);
    setPagination(res, totalCount, query);
    return res
      .status(200)
      .json({ status: 'success', message: 'Posts retrieved successfully', data: items });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 관리용 글 상세 조회 (초안 포함)
 * @route GET /api/admin/posts/:id
 * @access adminNormal 이상
 */
export const getAdminPost = async (
  req: AuthRequest,
  res: Response<PostResponse<AdminPostDetail>>,
  next: NextFunction,
) => {
  try {
    const data = await postService.getForAdmin(postId(req));
    if (!data) return notFound(res);
    return res
      .status(200)
      .json({ status: 'success', message: 'Post retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 글 작성
 * @route POST /api/admin/posts
 * @access adminNormal 이상
 */
export const createPost = async (
  req: AuthRequest,
  res: Response<PostResponse<AdminPostDetail>>,
  next: NextFunction,
) => {
  try {
    // 봇은 라우터에서 막히고 requireAdmin이 세션 멤버를 보장한다.
    const authorId = req.discordMemberId as string;
    const data = await postService.create(req.body as PostCreateInput, authorId);
    return res.status(201).json({ status: 'success', message: 'Post created successfully', data });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 글 수정·공개 전환
 * @route PATCH /api/admin/posts/:id
 * @access adminNormal 이상
 */
export const updatePost = async (
  req: AuthRequest,
  res: Response<PostResponse<AdminPostDetail>>,
  next: NextFunction,
) => {
  try {
    const data = await postService.update(postId(req), req.body as PostUpdateInput);
    if (!data) return notFound(res);
    return res.status(200).json({ status: 'success', message: 'Post updated successfully', data });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 글 삭제 (soft delete)
 * @route DELETE /api/admin/posts/:id
 * @access adminNormal 이상
 */
export const deletePost = async (
  req: AuthRequest,
  res: Response<PostResponse<{ id: number }>>,
  next: NextFunction,
) => {
  try {
    const id = postId(req);
    if (!(await postService.remove(id))) return notFound(res);
    return res
      .status(200)
      .json({ status: 'success', message: 'Post deleted successfully', data: { id } });
  } catch (error) {
    return next(error);
  }
};
