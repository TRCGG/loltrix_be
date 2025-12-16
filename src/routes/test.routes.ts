import { Router } from 'express';
import { testError, testValidationError, testDatabaseError } from '../controllers/test.controller.js';

const router:Router = Router();

// 테스트용 에러 발생 라우트들

router.get('/error/generic', 
  /* #swagger.ignore = true */
  testError
);

router.get('/error/validation', 
  /* #swagger.ignore = true */
  testValidationError
);

router.get('/error/database', 
  /* #swagger.ignore = true */
  testDatabaseError
);

export default router;