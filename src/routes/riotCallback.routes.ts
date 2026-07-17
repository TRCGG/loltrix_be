import { Router } from 'express';
import { handleRiotCallback } from '../controllers/riotCallback.controller.js';

const router: Router = Router();

/**
 * @route POST /api/callback/riot/:secret
 * @desc Riot 토너먼트 콜백 수신 (무인증 — 경로 시크릿으로 자체 인증). 세션 인증 체인보다 위에 등록.
 */
router.post(
  '/riot/:secret',
  /* #swagger.tags = ['Tournament']
    #swagger.summary = 'Riot 토너먼트 콜백 수신'
    #swagger.description = '경기 종료 콜백. 경로 시크릿 검증(불일치 시 404 위장) → match-v5 재검증(info.tournamentCode 대조) → 코드 COMPLETED 전이. 페이로드는 신뢰하지 않습니다.'
  */
  handleRiotCallback,
);

export default router;
