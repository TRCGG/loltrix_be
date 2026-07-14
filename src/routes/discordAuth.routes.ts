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
  // security 설정 생략 -> 전역 설정(cookieAuth OR botAuth) 자동 적용됨
  /* #swagger.tags = ['Auth']
    #swagger.summary = '내 정보 조회'
    #swagger.description = '현재 로그인된 세션 정보를 바탕으로 유저 정보를 조회합니다. (쿠키 또는 봇 헤더 필요)'
    #swagger.responses[200] = {
      description: '성공. avatar는 완성된 이미지 URL(없으면 null)이라 프론트에서 그대로 img src로 사용 가능.',
      schema: {
        status: 'success',
        message: 'session OK',
        data: {
          user: {
            id: '123456789012345678',
            username: 'gildong',
            global_name: '홍길동',
            avatar: 'https://cdn.discordapp.com/avatars/123456789012345678/abc123.png'
          }
        }
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
  // security 설정 생략 -> 전역 설정 자동 적용
  /* #swagger.tags = ['Auth']
    #swagger.summary = '내 길드 목록 조회'
    #swagger.description = '현재 유저가 속한 GMOK 길드 목록을 조회합니다.'
    #swagger.responses[200] = {
      description: '조회 성공. role은 해당 길드에서의 내 권한(userNormal/userUploader/guildManager/adminNormal/adminSuper). icon/banner는 Discord 해시 값(전체 URL 아님)이며 없으면 null, admin 계정 조회 시에는 빈 문자열. nick은 길드 별명(없으면 필드 생략).',
      schema: {
        status: 'success',
        message: 'gmok Guilds find successfully',
        data: [
          { id: '987654321098765432', name: '내 길드', icon: 'a1b2c3d4e5f6a7b8c9d0', banner: null, nick: '홍길동', role: 'guildManager' },
          { id: '876543210987654321', name: '다른 길드', icon: null, banner: null, role: 'userNormal' }
        ]
      }
    }
  */
  verifyAuth,
  getGmokGuilds,
);

export default router;
