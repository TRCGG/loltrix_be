import { Router } from 'express';
import { verifyAuth } from '../middlewares/authHandler.js';
import healthRouter from './health.routes.js';
import exampleRouter from './example.routes.js';
import guildRouter from './guild.routes.js';
import testRouter from './test.routes.js';
import replayRouter from './replay.routes.js';
import authRouter from './discordAuth.routes.js';
import guildMemberRoutes from './guildMember.routes.js';

const router: Router = Router();

// Health check route
router.use('/health', healthRouter);

// discord auth routes 
router.use('/auth', authRouter);

// --- 아래 API 부터는 모두 세션 검증 ---
router.use(verifyAuth);

// Example routes with Zod validation
router.use('/examples', exampleRouter);

// Guild routes with CRUD operations
router.use('/guilds', guildRouter);

// Replay routes 
router.use('/replays', replayRouter);

// discord auth routes 
router.use('/auth', authRouter);

// Guild Meber routes
router.use('/guildMember', guildMemberRoutes);

// Test routes for error logging (개발 환경에서만)
if (process.env.NODE_ENV === 'development') {
  router.use('/test', testRouter);
}

export default router;
