// discordAuth.routes.ts
import { Router } from 'express';
import {
  login,
  callback,
  logout,
  getGmokGuilds,
  getSelfProfile,
} from '../controllers/discordAuth.controller.js';

import { verifyAuth } from '../middlewares/authHandler.js';

const router: Router = Router();

/**
 * @route GET /api/auth/login
 * @desc 디스코드 로그인 시작
 * @access Public
 */
router.get(
  '/login',
  /* #swagger.tags = ['Auth']
    #swagger.summary = '디스코드 로그인 시작'
    #swagger.description = '디스코드 OAuth2 로그인 페이지로 리다이렉트합니다.'
    #swagger.security = [] 
  */
  login,
);

/**
 * @route GET /api/auth/callback
 * @desc 디스코드 로그인 콜백 처리
 * @access Public
 */
router.get(
  '/callback',
  /* #swagger.tags = ['Auth']
    #swagger.summary = '디스코드 로그인 콜백'
    #swagger.description = '디스코드 인증 후 리다이렉트되는 콜백 URL입니다.'
    #swagger.security = []
  */
  callback,
);

/**
 * @route POST /api/auth/logout
 * @desc 로그아웃 (토큰 폐기)
 * @access Public
 */
router.post(
  '/logout',
  /* #swagger.tags = ['Auth']
    #swagger.summary = '로그아웃'
    #swagger.description = '세션 쿠키를 제거하여 로그아웃 처리합니다.'
    #swagger.security = []
  */
  logout,
);

// --- 보호된 라우트 (인증 필요) ---

/**
 * @route GET /api/auth/me
 * @desc 세션 체크 및 내 유저 ID 조회
 * @access Private
 */
router.get(
  '/me',
  /* #swagger.tags = ['Auth']
    #swagger.summary = '내 정보 조회'
    #swagger.description = '현재 로그인된 세션 정보를 바탕으로 유저 정보를 조회합니다. (쿠키 또는 봇 헤더 필요)'
    // security 설정 생략 -> 전역 설정(cookieAuth OR botAuth) 자동 적용됨
    #swagger.responses[200] = {
      description: '성공',
      schema: {
        userId: 'string',
        username: 'string',
        avatar: 'string'
      }
    }
  */
  verifyAuth,
  getSelfProfile,
);

/**
 * @route GET /api/auth/gmokGuilds
 * @desc 현재 유저의 길드 목록 조회
 * @access Private
 */
router.get(
  '/gmokGuilds',
  /* #swagger.tags = ['Auth']
    #swagger.summary = '내 길드 목록 조회'
    #swagger.description = '현재 유저가 속한 GMOK 길드 목록을 조회합니다.'
    // security 설정 생략 -> 전역 설정 자동 적용
  */
  verifyAuth,
  getGmokGuilds,
);

export default router;
