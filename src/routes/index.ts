import { Router } from 'express';
import healthRouter from './health.routes';
import exampleRouter from './example.routes';

const router: Router = Router();

// Health check route
router.use('/health', healthRouter);

// Example routes with Zod validation
router.use('/examples', exampleRouter);

export default router;
