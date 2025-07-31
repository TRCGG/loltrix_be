import { Router } from 'express';
import healthRouter from './health.routes.js';
import exampleRouter from './example.routes.js';
import guildRouter from './guild.routes.js';

const router: Router = Router();

// Health check route
router.use('/health', healthRouter);

// Example routes with Zod validation
router.use('/examples', exampleRouter);

// Guild routes with CRUD operations
router.use('/guilds', guildRouter);

export default router;
