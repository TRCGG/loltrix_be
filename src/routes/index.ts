import { Router } from 'express';
import healthRouter from './health.routes.js';
import exampleRouter from './example.routes.js';
import guildRouter from './guild.routes.js';
import testRouter from './test.routes.js';

const router: Router = Router();

// Health check route
router.use('/health', healthRouter);

// Example routes with Zod validation
router.use('/examples', exampleRouter);

// Guild routes with CRUD operations
router.use('/guilds', guildRouter);

// Test routes for error logging (개발 환경에서만)
if (process.env.NODE_ENV === 'development') {
  router.use('/test', testRouter);
}

export default router;
