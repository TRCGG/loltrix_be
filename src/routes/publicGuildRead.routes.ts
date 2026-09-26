import { NextFunction, Request, Response, Router } from 'express';
import { guildService } from '../services/guild.service.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { validateRequest } from '../middlewares/validateRequest.js';
import { searchGuildMembers } from '../controllers/guildMember.controller.js';
import {
  getRecentGames,
  getMatchDashboard,
  getMostPicks,
  getGameDetail,
} from '../controllers/matchParticipant.controller.js';
import { getUserGameStats, getChampionStats } from '../controllers/statistics.controller.js';
import { getFrequentOpponents, getH2hDetail } from '../controllers/h2h.controller.js';
import { searchGuildMembersSchema } from './guildMember.routes.js';
import {
  gameDetailSchema,
  matchDashboardSchema,
  mostPickSchema,
  matchListSchema,
} from './matchParticipant.routes.js';
import { userFilterSchema, championFilterSchema } from './statistics.route.js';
import { frequentSchema, detailSchema } from './h2h.routes.js';

const router: Router = Router();
const MAX_ENCODED_GUILD_ID_SIZE = 2048;
const MAX_GUILD_ID_SIZE = 128;
const MANAGEMENT_GUILD_MEMBER_PATHS = new Set([
  'members',
  'sub-accounts',
  'discord-members',
  'audit-logs',
]);

/**
 * @desc 공개 여부 판정용 길드 ID를 엄격히 디코딩합니다.
 * 요청은 변경하지 않으며, 잘못된 값은 null로 돌려 기존 인증 경로에 맡깁니다.
 */
export const decodePublicGuildId = (encodedGuildId: string): string | null => {
  if (!encodedGuildId || encodedGuildId.length > MAX_ENCODED_GUILD_ID_SIZE) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encodedGuildId)) return null;

  const firstPadding = encodedGuildId.indexOf('=');
  if (firstPadding !== -1 && encodedGuildId.length % 4 !== 0) return null;

  const unpadded = encodedGuildId.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;

  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== unpadded) return null;

  const guildId = bytes.toString('utf8');
  if (!guildId || guildId.length > MAX_GUILD_ID_SIZE) return null;
  if (!Buffer.from(guildId, 'utf8').equals(bytes)) return null;

  return guildId;
};

/**
 * @desc 공개 중인 길드의 읽기 요청만 통과시킵니다.
 * 봇 헤더, 비공개 길드, 조회 실패는 기존 인증 경로에서 처리합니다.
 */
export const requirePublicGuild = async (
  req: Request<{ guildId: string }>,
  res: Response,
  next: NextFunction,
) => {
  if (req.headers['x-discord-bot']) return next('router');

  const guildId = decodePublicGuildId(req.params.guildId);
  if (!guildId) return next('router');

  try {
    if (!(await guildService.isPublicGuild(guildId))) return next('router');
  } catch {
    return next('router');
  }

  res.setHeader('Cache-Control', 'no-store');
  return next();
};

/**
 * @desc 관리 경로가 소환사 검색 와일드카드에 잡혀 공개되지 않도록 제외합니다.
 */
export const rejectGuildMemberManagementPath = (
  req: Request<{ riotName: string }>,
  _res: Response,
  next: NextFunction,
) => {
  if (MANAGEMENT_GUILD_MEMBER_PATHS.has(req.params.riotName.toLowerCase())) {
    return next('router');
  }
  return next();
};

router.get(
  '/guildMember/:guildId/:riotName',
  rejectGuildMemberManagementPath,
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(searchGuildMembersSchema),
  searchGuildMembers,
);

router.get(
  '/matches/:guildId/:riotName/games',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(matchListSchema),
  getRecentGames,
);
router.get(
  '/matches/:guildId/:riotName/dashboard',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(matchDashboardSchema),
  getMatchDashboard,
);
router.get(
  '/matches/:guildId/:riotName/most-picks',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(mostPickSchema),
  getMostPicks,
);
router.get(
  '/matches/:guildId/games/:gameId',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(gameDetailSchema),
  getGameDetail,
);

router.get(
  '/statistics/:guildId/users',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(userFilterSchema),
  getUserGameStats,
);
router.get(
  '/statistics/:guildId/champions',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(championFilterSchema),
  getChampionStats,
);

router.get(
  '/h2h/:guildId/frequent',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(frequentSchema),
  getFrequentOpponents,
);
router.get(
  '/h2h/:guildId',
  requirePublicGuild,
  decodeGuildIdMiddleware,
  validateRequest(detailSchema),
  getH2hDetail,
);

export default router;
