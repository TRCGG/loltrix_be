import { Router } from 'express';
import { verifyAuth, restrictBotToLocalhost } from '../middlewares/authHandler.js';
import healthRouter from './health.routes.js';
import exampleRouter from './example.routes.js';
import guildRouter from './guild.routes.js';
import testRouter from './test.routes.js';
import replayRouter from './replay.routes.js';
import authRouter from './discordAuth.routes.js';
import guildMemberRoutes from './guildMember.routes.js';
import matchParticipantRoutes from './matchParticipant.routes.js';
import statisticsRoutes from './statistics.route.js';
import h2hRoutes from './h2h.routes.js';
import riotCallbackRoutes from './riotCallback.routes.js';
import tournamentRoutes from './tournament.routes.js';

const router: Router = Router();

// Health check route
router.use('/health', healthRouter);

// discord auth routes
router.use('/auth', authRouter);

// Riot 토너먼트 콜백 — 세션 없는 외부 호출. 경로 시크릿으로 자체 인증하므로 인증 체인보다 위.
router.use('/callback', riotCallbackRoutes);

// --- 아래 API 부터는 모두 세션 검증 ---
router.use(restrictBotToLocalhost, verifyAuth);

// 토너먼트 코드 발급/조회 — 봇 전용(localhost 제한). 인증 체인 아래.
router.use('/tournament', tournamentRoutes);

// Example routes with Zod validation
router.use('/examples', exampleRouter);

// Guild routes with CRUD operations
router.use('/guilds', guildRouter);

// Replay routes
router.use('/replays', replayRouter);

// Guild Meber routes
router.use('/guildMember', guildMemberRoutes);

// match
router.use('/matches', matchParticipantRoutes);

router.use('/statistics', statisticsRoutes);

router.use('/h2h', h2hRoutes);

// Test routes for error logging (개발 환경에서만)
if (process.env.NODE_ENV === 'development') {
  router.use('/test', testRouter);
}

export default router;
