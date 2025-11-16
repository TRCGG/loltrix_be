// discordAuth.routes.ts
import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  login,
  callback,
  logout,
  getGmokGuilds,
  getSelfProfile,
} from '../controllers/discordAuth.controller.js';

import { verifyAuth } from '../middlewares/authHandler.js';

const router: Router = Router();

// --- Zod 유효성 검사 스키마 ---
const callbackSchema = z.object({
  query: z.object({
    code: z.string().min(1, 'Discord authorization code is required'),
  }),
});

/**
 * @route GET /api/auth/login
 * @desc 디스코드 로그인 시작
 * @access Public
 */
router.get('/login', login);

/**
 * @route GET /api/auth/callback
 * @desc 디스코드 로그인 콜백 처리
 * @access Public
 */
router.get('/callback', validateRequest(callbackSchema), callback);

/**
 * @route POST /api/auth/logout
 * @desc 로그아웃 (토큰 폐기)
 * @access Public
 */
router.post('/logout', logout);

// --- 보호된 라우트 (인증 필요) ---

/**
 * @route GET /api/auth/me
 * @desc 세션 체크 및 내 유저 ID 조회
 * @access Private
 */
router.get(
  '/me',
  verifyAuth, // 1. 인증 미들웨어가 토큰/봇을 검증
  getSelfProfile, // 2. 검증 통과 시 컨트롤러 실행
);

/**
 * @route GET /api/auth/gmokGuilds
 * @desc 현재 유저의 길드 목록 조회
 * @access Private
 */
router.get('/gmokGuilds', verifyAuth, getGmokGuilds);

export default router;
