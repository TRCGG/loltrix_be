import { Router } from 'express';
import { testError, testValidationError, testDatabaseError } from '../controllers/test.controller.js';

const router = Router();

// 테스트용 에러 발생 라우트들
router.get('/error/generic', testError);
router.get('/error/validation', testValidationError);
router.get('/error/database', testDatabaseError);

export default router;