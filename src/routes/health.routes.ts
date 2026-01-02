import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';

const router: Router = Router();

/**
 * @route GET /api/health
 * @desc 헬스 체크 엔드포인트
 * @access Public
 */

router.get(
  '/',
  // #swagger.tags = ['Health']
  // #swagger.security = []
  getHealth,
);

export default router;
