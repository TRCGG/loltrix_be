import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  getDailyNews,
  saveDailyNews,
  getMonthlyNews,
  saveMonthlyNews,
  getNewsConfig,
  updateNewsConfig,
} from '../controllers/news.controller.js';

const router: Router = Router();

// --- Zod 스키마 ---

const guildIdParamSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
});

const saveDailyNewsSchema = z.object({
  body: z.object({
    guildId: z.string().min(1).max(128),
    newsDate: z.string().min(1),
    title: z.string().max(256),
    discordContent: z.string(),
    webContent: z.string(),
    statsJson: z.record(z.any()),
  }),
});

const saveMonthlyNewsSchema = z.object({
  body: z.object({
    guildId: z.string().min(1).max(128),
    year: z.number().int().min(2020).max(2099),
    month: z.number().int().min(1).max(12),
    title: z.string().max(256),
    discordContent: z.string(),
    webContent: z.string(),
    statsJson: z.record(z.any()),
  }),
});

const updateConfigSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
  }),
  body: z.object({
    newsEnabled: z.boolean().optional(),
    mmrEnabled: z.boolean().optional(),
    channelId: z.string().max(128).optional(),
    tone: z.enum(['funny', 'serious', 'meme']).optional(),
  }),
});

// --- 조회 API (trcgg_bot → loltrix_be) ---

/**
 * @route GET /api/news/daily/:guildId
 * @desc 일일 뉴스 조회 (?date=YYYY-MM-DD)
 * @access Protected
 */
router.get(
  '/daily/:guildId',
  // #swagger.tags = ['News']
  validateRequest(guildIdParamSchema),
  getDailyNews,
);

/**
 * @route GET /api/news/monthly/:guildId
 * @desc 월간 뉴스 조회 (?year=&month=)
 * @access Protected
 */
router.get(
  '/monthly/:guildId',
  // #swagger.tags = ['News']
  validateRequest(guildIdParamSchema),
  getMonthlyNews,
);

/**
 * @route GET /api/news/config/:guildId
 * @desc 뉴스 설정 조회
 * @access Protected
 */
router.get(
  '/config/:guildId',
  // #swagger.tags = ['News']
  validateRequest(guildIdParamSchema),
  getNewsConfig,
);

// --- 저장+발행 API (loltrix_batch → loltrix_be) ---

/**
 * @route POST /api/news/daily
 * @desc 일일 뉴스 저장 + 디스코드 발행
 * @access Protected (배치)
 */
router.post(
  '/daily',
  // #swagger.tags = ['News']
  validateRequest(saveDailyNewsSchema),
  saveDailyNews,
);

/**
 * @route POST /api/news/monthly
 * @desc 월간 뉴스 저장 + 디스코드 발행
 * @access Protected (배치)
 */
router.post(
  '/monthly',
  // #swagger.tags = ['News']
  validateRequest(saveMonthlyNewsSchema),
  saveMonthlyNews,
);

/**
 * @route PUT /api/news/config/:guildId
 * @desc 뉴스 설정 수정
 * @access Protected
 */
router.put(
  '/config/:guildId',
  // #swagger.tags = ['News']
  validateRequest(updateConfigSchema),
  updateNewsConfig,
);

export default router;
