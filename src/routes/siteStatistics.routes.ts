import { Router } from 'express';
import { getSiteOverview } from '../controllers/siteStatistics.controller.js';

const router: Router = Router();

/**
 * @route GET /api/statistics/overview
 * @desc 사이트 전체 이용현황 (비로그인 허용)
 */
router.get(
  '/statistics/overview',
  /* #swagger.tags = ['Statistics']
    #swagger.summary = '사이트 이용현황'
    #swagger.description = '세션 없이 사이트 전체 집계를 조회합니다. 삭제된 클랜·경기는 빼고, 비공개 클랜 경기는 숫자에 포함합니다. clanCount는 경기가 1건 이상 있는 클랜 수, playerCount는 본캐·부캐를 따로 센 소환사 수, recentMatchCount는 최근 30일 경기 수입니다. matchCountByType.competition은 스크림·예선·본선 합계입니다. 결과는 매일 낮 12시(KST)에 갱신됩니다.'
    #swagger.security = []
    #swagger.responses[200] = {
      description: '조회 성공',
      schema: {
        status: 'success',
        message: 'Site overview retrieved successfully',
        data: { clanCount: 12, matchCount: 3400, playerCount: 860, recentMatchCount: 240, matchCountByType: { normal: 3100, competition: 300 } }
      }
    }
  */
  getSiteOverview,
);

export default router;
