import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { requireGuildRole } from '../middlewares/requireRole.js';
import {
  addTeamMember,
  approveApplication,
  assignMatchTeams,
  closeCompetition,
  createApplication,
  createCompetition,
  createTeam,
  deleteCompetition,
  deleteTeam,
  getCompetitionDetail,
  getTeamHeadToHead,
  getTeamRecords,
  listApplications,
  listCompetitionMatches,
  listCompetitions,
  listTeams,
  rejectApplication,
  removeTeamMember,
  resolveCompetition,
  updateTeam,
} from '../controllers/competition.controller.js';

const router: Router = Router();

const guildParams = z.object({
  guildId: z.string().min(1, 'Guild ID is required').max(128),
});

const competitionParams = guildParams.extend({
  competitionId: z.string().regex(/^\d{1,9}$/, 'competitionId must be a number'),
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

const teamParams = competitionParams.extend({
  teamId: z.string().regex(/^\d{1,9}$/, 'teamId must be a number'),
});

const applicationParams = competitionParams.extend({
  applicationId: z.string().regex(/^\d{1,9}$/, 'applicationId must be a number'),
});

const applySchema = z.object({
  params: competitionParams,
  body: z.object({
    playerCode: z.string().trim().min(1, 'playerCode is required').max(64),
    title: z.string().trim().min(1, 'title is required').max(64),
    availableTime: z.string().trim().max(128).optional(),
    captainAvailable: z.string().trim().max(64).optional(),
    position: z.string().trim().max(16).optional(),
    subPosition: z.string().trim().max(16).optional(),
    comment: z.string().trim().max(256).optional(),
  }),
});

const listApplicationsSchema = z.object({
  params: competitionParams,
  query: z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }),
});

const decideApplicationSchema = z.object({ params: applicationParams, body: actorBody });

const createTeamSchema = z.object({
  params: competitionParams,
  body: z.object({
    name: z.string().trim().min(1, 'name is required').max(64, 'name must be 64 characters or less'),
  }),
});

const listTeamsSchema = z.object({ params: competitionParams });

const updateTeamSchema = z.object({
  params: teamParams,
  body: z.object({
    name: z.string().trim().min(1).max(64).optional(),
    captainPlayerCode: z.string().trim().min(1).max(64).nullable().optional(),
  }),
});

const teamSchema = z.object({ params: teamParams });

const addMemberSchema = z.object({
  params: teamParams,
  body: z.object({ playerCode: z.string().trim().min(1, 'playerCode is required').max(64) }),
});

const removeMemberSchema = z.object({
  params: teamParams.extend({ playerCode: z.string().min(1).max(64) }),
});

const listMatchesSchema = z.object({
  params: competitionParams,
  query: z.object({ unassigned: z.enum(['true', 'false']).optional() }),
});

const assignMatchTeamsSchema = z.object({
  params: competitionParams.extend({ customMatchId: z.string().min(1).max(255) }),
  body: z.object({
    blue: z.number().int().positive().nullable(),
    red: z.number().int().positive().nullable(),
    actorMemberId: z.string().min(1).max(64).optional(),
  }),
});

const headToHeadSchema = z.object({
  params: competitionParams,
  query: z.object({
    teamA: z.string().regex(/^\d{1,9}$/, 'teamA must be a number'),
    teamB: z.string().regex(/^\d{1,9}$/, 'teamB must be a number'),
  }),
});

/**
 * @route POST /api/competitions/:guildId/:competitionId/applications
 * @desc 대회 개인 신청 (웹 로그인 사용자 본인)
 */
router.post(
  '/:guildId/:competitionId/applications',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 신청'
    #swagger.description = '로그인한 사용자가 대회에 개인 신청합니다. 봇 요청은 403 — 신청자를 특정할 세션이 없습니다. playerCode는 저장 시 본계정으로 정규화되며, 한 대회에 한 계정은 한 번만 신청할 수 있습니다(409 application-duplicate). 종료된 대회는 409(competition-closed).'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { playerCode: 'PLR_000123', title: '탑 지원합니다', availableTime: '평일 21시 이후', captainAvailable: '가능', position: 'TOP', subPosition: 'JUNGLE', comment: '잘 부탁드립니다' } }
  */
  decodeGuildIdMiddleware,
  validateRequest(applySchema),
  createApplication,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId/applications
 * @desc 신청 목록 (status 필터)
 */
router.get(
  '/:guildId/:competitionId/applications',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 신청 목록'
    #swagger.description = '최신순. 각 항목에 riotName·riotNameTag가 붙습니다. status로 PENDING/APPROVED/REJECTED 필터.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['status'] = { in: 'query', type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }
  */
  decodeGuildIdMiddleware,
  validateRequest(listApplicationsSchema),
  listApplications,
);

/**
 * @route PATCH /api/competitions/:guildId/:competitionId/applications/:applicationId/approve
 * @desc 신청 승인 — 승인이 팀 배정을 만들지는 않는다 (편성은 로스터 API로)
 * @access guildManager 이상
 */
router.patch(
  '/:guildId/:competitionId/applications/:applicationId/approve',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 신청 승인'
    #swagger.description = 'APPROVED로 바꾸고 guild_audit_log(applicationDecide)에 남깁니다. 이미 REJECTED여도 승인할 수 있습니다. 승인은 로스터 등록의 전제가 아닙니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['applicationId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(decideApplicationSchema),
  approveApplication,
);

/**
 * @route PATCH /api/competitions/:guildId/:competitionId/applications/:applicationId/reject
 * @desc 신청 거절
 * @access guildManager 이상
 */
router.patch(
  '/:guildId/:competitionId/applications/:applicationId/reject',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 신청 거절'
    #swagger.description = 'REJECTED로 바꾸고 guild_audit_log(applicationDecide)에 남깁니다. APPROVED였어도 거절로 되돌릴 수 있습니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['applicationId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(decideApplicationSchema),
  rejectApplication,
);

/**
 * @route POST /api/competitions/:guildId/:competitionId/teams
 * @desc 팀 생성 (대회당 최대 20팀)
 * @access guildManager 이상
 */
router.post(
  '/:guildId/:competitionId/teams',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 팀 생성'
    #swagger.description = '대회명과 같은 공백 정규화를 거칩니다. 대회당 20팀을 넘으면 409(team-limit-exceeded), 같은 이름이 있으면 409(team-name-exists), 종료된 대회는 409(competition-closed).'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { name: '1팀' } }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(createTeamSchema),
  createTeam,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId/teams
 * @desc 팀 목록 + 로스터
 */
router.get(
  '/:guildId/:competitionId/teams',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 팀 목록'
    #swagger.description = '각 팀에 roster(playerCode·riotName·riotNameTag)가 붙습니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(listTeamsSchema),
  listTeams,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId/teams/:teamId/records
 * @desc 상대 팀별 전적 (스크림/본경기 분리)
 */
router.get(
  '/:guildId/:competitionId/teams/:teamId/records',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '팀의 상대별 전적'
    #swagger.description = '상대 팀마다 scrim·main의 games/win/lose. 양 진영이 모두 팀에 귀속된 경기만 셉니다(용병전 제외). 삭제된 경기는 빠집니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(teamSchema),
  getTeamRecords,
);

/**
 * @route PATCH /api/competitions/:guildId/:competitionId/teams/:teamId
 * @desc 팀 이름·팀장 변경
 * @access guildManager 이상
 */
router.patch(
  '/:guildId/:competitionId/teams/:teamId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 팀 수정'
    #swagger.description = 'captainPlayerCode는 그 팀 로스터에 있는 계정이어야 합니다(400 captain-not-in-roster). null을 보내면 팀장을 비웁니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { name: '1팀', captainPlayerCode: 'PLR_000123' } }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(updateTeamSchema),
  updateTeam,
);

/**
 * @route DELETE /api/competitions/:guildId/:competitionId/teams/:teamId
 * @desc 팀 삭제 — 귀속 경기가 없을 때만
 * @access guildManager 이상
 */
router.delete(
  '/:guildId/:competitionId/teams/:teamId',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 팀 삭제'
    #swagger.description = '이 팀으로 귀속된 활성 경기가 하나라도 있으면 409(team-has-matches). 로스터는 함께 지워집니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamId'] = { in: 'path', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(teamSchema),
  deleteTeam,
);

/**
 * @route POST /api/competitions/:guildId/:competitionId/teams/:teamId/members
 * @desc 로스터 등록 (팀당 최대 6명)
 * @access guildManager 이상
 */
router.post(
  '/:guildId/:competitionId/teams/:teamId/members',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '로스터 등록'
    #swagger.description = 'playerCode는 본계정으로 정규화해 저장합니다. 팀당 6명을 넘으면 409(roster-limit-exceeded), 이미 이 대회의 다른 팀에 있으면 409(roster-duplicate), 종료된 대회는 409(competition-closed). 승인(APPROVED)은 전제가 아닙니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { playerCode: 'PLR_000123' } }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(addMemberSchema),
  addTeamMember,
);

/**
 * @route DELETE /api/competitions/:guildId/:competitionId/teams/:teamId/members/:playerCode
 * @desc 로스터 제거 — 팀장이면 팀장도 비운다
 * @access guildManager 이상
 */
router.delete(
  '/:guildId/:competitionId/teams/:teamId/members/:playerCode',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '로스터 제거'
    #swagger.description = '교체는 제거 후 등록입니다. 제거 대상이 팀장이면 captainPlayerCode가 NULL이 됩니다. 종료된 대회는 409(competition-closed).'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['playerCode'] = { in: 'path', required: true, type: 'string' }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(removeMemberSchema),
  removeTeamMember,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId/matches
 * @desc 대회 경기 목록 (unassigned=true면 자동 배정 실패분만)
 */
router.get(
  '/:guildId/:competitionId/matches',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '대회 경기 목록 (팀 귀속)'
    #swagger.description = '경기마다 blueTeamId·redTeamId(미배정이면 null, 용병전도 null)와 양 진영 참가자 요약을 반환합니다. unassigned=true면 귀속 행이 아예 없는 경기(운영진 수동 지정 대상)만 반환합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['unassigned'] = { in: 'query', type: 'string', enum: ['true', 'false'] }
  */
  decodeGuildIdMiddleware,
  validateRequest(listMatchesSchema),
  listCompetitionMatches,
);

/**
 * @route PUT /api/competitions/:guildId/:competitionId/matches/:customMatchId/teams
 * @desc 경기의 팀 귀속 지정·정정 (대회 종료 후에도 허용)
 * @access guildManager 이상
 */
router.put(
  '/:guildId/:competitionId/matches/:customMatchId/teams',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '경기 팀 귀속 지정'
    #swagger.description = 'blue·red에 팀 id를 주거나 null(용병전)을 줍니다. 양쪽 null·같은 팀 양쪽은 400, 이 대회 팀이 아니면 400(team-not-in-competition), 이 길드·이 대회 경기가 아니면 404. 대회가 종료돼도 정정할 수 있습니다. guild_audit_log(matchTeamAssign)에 남습니다.'
    #swagger.security = [{ "session": [] }]
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['customMatchId'] = { in: 'path', required: true, type: 'string' }
    #swagger.parameters['body'] = { in: 'body', required: true, schema: { blue: 1, red: 2, actorMemberId: '123456789012345678' } }
  */
  decodeGuildIdMiddleware,
  manager,
  validateRequest(assignMatchTeamsSchema),
  assignMatchTeams,
);

/**
 * @route GET /api/competitions/:guildId/:competitionId/records
 * @desc 두 팀 맞대결 전적 + 경기 목록
 */
router.get(
  '/:guildId/:competitionId/records',
  /* #swagger.auto = false
    #swagger.tags = ['Competition']
    #swagger.summary = '팀 맞대결 전적'
    #swagger.description = 'teamA 관점의 scrim·main 전적과 해당 경기 목록(customMatchId·gameType·date·winnerTeamId)을 반환합니다. 양 진영이 모두 팀에 귀속된 경기만 셉니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: '길드 ID (Base64)', required: true, type: 'string' }
    #swagger.parameters['competitionId'] = { in: 'path', required: true, type: 'integer' }
    #swagger.parameters['teamA'] = { in: 'query', required: true, type: 'integer' }
    #swagger.parameters['teamB'] = { in: 'query', required: true, type: 'integer' }
  */
  decodeGuildIdMiddleware,
  validateRequest(headToHeadSchema),
  getTeamHeadToHead,
);

export default router;
