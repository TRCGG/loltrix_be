import { Router } from 'express';
import { z } from 'zod';
import { getPlayerMmr } from '../controllers/mmr.controller.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { validateRequest } from '../middlewares/validateRequest.js';

const router: Router = Router();

const playerMmrSchema = z.object({
  params: z.object({
    puuid: z
      .string()
      .min(1, 'puuid is required')
      .max(128, 'puuid must be less than 128 characters'),
  }),
  query: z.object({
    guildId: z
      .string()
      .min(1, 'guildId is required')
      .max(128, 'guildId must be less than 128 characters'),
  }),
});

router.get(
  '/players/:puuid',
  /* #swagger.auto = false
    #swagger.tags = ['MMR']
    #swagger.summary = '플레이어 MMR 조회'
    #swagger.description = 'puuid와 guildId로 길드별 현재 MMR 및 마지막 매치 변동값을 조회합니다.'
    #swagger.parameters['puuid'] = {
      in: 'path',
      description: 'Riot PUUID',
      required: true,
      type: 'string'
    }
    #swagger.parameters['guildId'] = {
      in: 'query',
      description: 'Base64 encoded Discord guild ID',
      required: true,
      type: 'string'
    }
  */
  decodeGuildIdMiddleware,
  validateRequest(playerMmrSchema),
  getPlayerMmr,
);

export default router;
