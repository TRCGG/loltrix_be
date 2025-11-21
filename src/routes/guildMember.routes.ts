import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  searchGuildMembers, 
  linkSubAccount,
  getSubAccounts,
  removeSubAccount,
} from '../controllers/guildMember.controller.js'; // 경로 수정 필요

const router: Router = Router();

// --- Define Zod schemas for validation ---

const searchGuildMembersSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
    riotName: z
      .string()
      .min(1, 'riotName is required')
      .max(128, 'riotName must be less than 128 characters'),
  }),
  query: z.object({
    riotNameTag: z
      .string()
      .min(1, 'riotNameTag is required')
      .max(128, 'Search term must be less than 128 characters')
      .optional(),
    limit: z
      .string()
      .regex(/^\d+$/, 'Limit must be a positive number')
      .transform(Number)
      .optional(),
  }),
});

const linkSubAccountSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    subRiotName: z.string().min(1, 'Sub Riot Name is required').max(128),
    subRiotTag: z.string().min(1, 'Sub Riot Tag is required').max(128),
    mainRiotName: z.string().min(1, 'Main Riot Name is required').max(128),
    mainRiotTag: z.string().min(1, 'Main Riot Tag is required').max(128),
  }),
});

const getSubAccountsSchema = z.object({
  params: z.object({
    guildId: z
      .string()
      .min(1, 'Guild ID is required')
      .max(128, 'Guild ID must be less than 128 characters'),
  }),
});

const removeSubAccountSchema = z.object({
  body: z.object({
    guildId: z.string().min(1, 'Guild ID is required').max(128),
    riotName: z.string().min(1, 'Riot Name is required').max(128),
    riotNameTag: z.string().min(1, 'Riot Tag is required').max(128),
  }),
});

// --- Define Routes ---

/**
 * @route POST /api/guildMember/sub-account
 * @desc 부계정을 본계정에 연결하고 DB 정보 업데이트 (트랜잭션 포함)
 */
router.post(
  '/sub-account', 
  validateRequest(linkSubAccountSchema),
  linkSubAccount
);

/**
 * @route GET /api/guildMember/:guildId/sub-accounts
 * @desc 특정 길드의 부계정 목록 조회
 */
router.get(
  '/:guildId/sub-accounts', 
  validateRequest(getSubAccountsSchema),
  getSubAccounts
);

/**
 * @route GET /api/guildMember/:guildId/:riotName
 * @desc 쿼리 파라미터로 길드 ID와 Riot ID를 받아 멤버 검색
 * @access Public
 */
router.get('/:guildId/:riotName', 
  validateRequest(searchGuildMembersSchema), 
  searchGuildMembers
);

/**
 * @route DELETE /api/guildMember/sub-account
 * @desc 부계정 연결 해제 (Hard Delete)
 */
router.delete(
  '/sub-account',
  validateRequest(removeSubAccountSchema),
  removeSubAccount
);

export default router;