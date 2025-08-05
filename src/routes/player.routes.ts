import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  getPlayerByRiotNameOrTag
} from '../controllers/player.controller.js';

const router: Router = Router();

const getPlayerByRiotNameOrTagSchema = z.object({
  params: z.object({
    riotName: z
    .string()
    .min(1, 'riotName is required')
    .max(128, 'riotName must be less than 128 characters'),
    riotNameTag: z
    .string()
    .max(128, 'riotNameTag must be less than 128 characters')
    .optional(),
    guildId: z
    .string()
    .min(1, 'Guild ID is required')
    .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

router.get('/:riotName/:guildId/:riotNameTag?', validateRequest(getPlayerByRiotNameOrTagSchema), getPlayerByRiotNameOrTag);

export default router;