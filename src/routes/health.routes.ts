import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';

const router: Router = Router();

/**
 * @route GET /api/health
 * @desc 헬스 체크 엔드포인트
 * @access Public
 */
router.get('/', getHealth);

export default router;
