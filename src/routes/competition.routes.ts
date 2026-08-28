import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { requireGuildRole } from '../middlewares/requireRole.js';
import {
  closeCompetition,
  createCompetition,
  deleteCompetition,
  getCompetitionDetail,
  listCompetitions,
  resolveCompetition,
} from '../controllers/competition.controller.js';

const router: Router = Router();

const guildParams = z.object({
  guildId: z.string().min(1, 'Guild ID is required').max(128),
});

const competitionParams = guildParams.extend({
  competitionId: z.string().regex(/^\d+$/, 'competitionId must be a number'),
});

// 봇(!대회개설 등) 경유 시 body.actorMemberId로 명령 사용자를 전달 (감사 로그용)
const actorBody = z.object({ actorMemberId: z.string().min(1).max(64).optional() }).optional();

const createSchema = z.object({
  params: guildParams,
  body: z.object({
    name: z.string().trim().min(1, 'name is required').max(64, 'name must be 64 characters or less'),
    actorMemberId: z.string().min(1).max(64).optional(),
  }),
});

const listSchema = z.object({
  params: guildParams,
  query: z.object({
    season: z.string().max(32).optional(),
    status: z.enum(['OPEN', 'CLOSED']).optional(),
  }),
});

const resolveSchema = z.object({
  params: guildParams,
  query: z.object({ name: z.string().max(64).optional() }),
});

const detailSchema = z.object({ params: competitionParams });
const mutateSchema = z.object({ params: competitionParams, body: actorBody });

const manager = requireGuildRole('guildManager', { from: 'params', key: 'guildId' });

/**
 * @route POST /api/competitions/:guildId
 * @desc 대회 개설 (길드당 OPEN 하나)
 * @access guildManager 이상
 */
router.post(
  '/:guildId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 개설'
    #swagger.description = '클랜 내 대회(멸망전 1회 등)를 OPEN 상태로 만듭니다. 길드당 OPEN 대회는 하나 — 이미 있으면 409(competition-open-exists), 같은 이름이 있으면 409(competition-name-exists). guildId는 Base64. 세션 guildManager 이상 또는 봇.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { name: '멸망전 1회', actorMemberId: '123456789012345678' } }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(createSchema),
  createCompetition,
);

/**
 * @route GET /api/competitions/:guildId
 * @desc 대회 목록 (유형별 경기 수 포함)
 */
router.get(
  '/:guildId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 목록'
    #swagger.description = '길드의 대회 목록을 최신순으로 반환합니다. 각 항목에 scrimCount(스크림)·mainCount(본경기) 활성 경기 수 포함. season·status 필터는 선택.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['season'] = { in: 'query', type: 'string' }
    #swagger.parameters['status'] = { in: 'query', type: 'string', enum: ['OPEN', 'CLOSED'] }
  */
  decodeGuildIdMiddleware,
  validateRequest(listSchema),
  listCompetitions,
);

/**
 * @route GET /api/competitions/:guildId/resolve
 * @desc 대회명 해석 — name 생략 시 OPEN(없으면 최근 종료), 정확 일치 → 부분일치 1건 → 후보 목록
 */
router.get(
  '/:guildId/resolve',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회명 해석'
    #swagger.description = 'name 생략: OPEN 대회, 없으면 최근 종료 대회. name 지정: 정확 일치 1건 → 없으면 부분일치가 정확히 1건일 때만 match, 2건 이상이면 candidates로 반환(사용자가 고르게). 봇 !전적대회·!대회통계의 대회명 인자 처리용.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['name'] = { in: 'query', type: 'string' }
  */
  decodeGuildIdMiddleware,
  validateRequest(resolveSchema),
  resolveCompetition,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId
 * @desc 대회 상세 (경기 목록 포함). 개인 통계는 /statistics·/matches에 competitionId를 넘겨 조회
 */
router.get(
  '/:guildId/:competitionId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 상세'
    #swagger.description = '대회 정보 + 유형별 경기 수 + 활성 경기 목록(gameId·gameType·createDate). 개인 랭킹·전적은 /api/statistics, /api/matches 에 competitionId 파라미터로 조회합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(detailSchema),
  getCompetitionDetail,
);

/**
 * @route PATCH /api/competitions/:guildId/:competitionId/close
 * @desc 대회 종료 — 이후 리플 태깅 불가(기록 잠금)
 * @access guildManager 이상
 */
router.patch(
  '/:guildId/:competitionId/close',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 종료'
    #swagger.description = 'OPEN 대회를 CLOSED로 바꿉니다. 종료 뒤엔 리플을 이 대회에 올릴 수 없으니 리플을 다 올린 뒤 종료하세요. OPEN이 아니면 404.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(mutateSchema),
  closeCompetition,
);

/**
 * @route DELETE /api/competitions/:guildId/:competitionId
 * @desc 대회 삭제 — 활성 경기 0건일 때만
 * @access guildManager 이상
 */
router.delete(
  '/:guildId/:competitionId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 삭제'
    #swagger.description = '활성 경기가 하나라도 있으면 409(competition-has-matches). 삭제된 경기(!drop)의 대회 참조는 끊고 하드 삭제합니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(mutateSchema),
  deleteCompetition,
);

export default router;
