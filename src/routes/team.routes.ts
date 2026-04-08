import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { validateRequest } from '../middlewares/validateRequest.js';
import {
  createTeam,
  getTeamsByGuild,
  getTeamByCode,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  getTeamMemberHistory,
  createTeamsFromExcel,
} from '../controllers/team.controller.js';

const router: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// --- Zod schemas ---

const guildIdParam = z.object({
  guildId: z.string().min(1).max(128),
});

const teamCodeParam = z.object({
  guildId: z.string().min(1).max(128),
  teamCode: z.string().min(1).max(64),
});

const createTeamSchema = z.object({
  params: guildIdParam,
  body: z.object({
    name: z.string().min(1, '팀 이름은 필수입니다.').max(128, '팀 이름은 128자 이하여야 합니다.'),
  }),
});

const getTeamsSchema = z.object({
  params: guildIdParam,
  query: z
    .object({
      page: z.string().regex(/^\d+$/).transform(Number).optional(),
      limit: z.string().regex(/^\d+$/).transform(Number).optional(),
      search: z.string().max(128).optional(),
    })
    .optional(),
});

const getTeamByCodeSchema = z.object({
  params: teamCodeParam,
});

const updateTeamSchema = z.object({
  params: teamCodeParam,
  body: z.object({
    name: z.string().min(1, '팀 이름은 필수입니다.').max(128, '팀 이름은 128자 이하여야 합니다.'),
  }),
});

const deleteTeamSchema = z.object({
  params: teamCodeParam,
});

const addTeamMemberSchema = z.object({
  params: teamCodeParam,
  body: z.object({
    riotName: z.string().min(1, '라이엇 닉네임은 필수입니다.').max(128),
    riotNameTag: z.string().min(1, '라이엇 태그는 필수입니다.').max(128),
    position: z.enum(['TOP', 'JUG', 'MID', 'ADC', 'SUP']).optional(),
  }),
});

const removeTeamMemberSchema = z.object({
  params: z.object({
    guildId: z.string().min(1).max(128),
    teamCode: z.string().min(1).max(64),
    playerCode: z.string().min(1).max(64),
  }),
});

const getTeamMemberHistorySchema = z.object({
  params: teamCodeParam,
});

const excelUploadSchema = z.object({
  params: guildIdParam,
});

// --- Routes ---

/**
 * @route POST /api/teams/:guildId
 * @desc 팀 생성
 */
router.post(
  '/:guildId',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀 생성'
    #swagger.description = '길드 내 새 팀을 생성합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { name: '거북이팀' }
    }
  */
  validateRequest(createTeamSchema),
  createTeam,
);

/**
 * @route GET /api/teams/:guildId
 * @desc 길드별 팀 목록 조회
 */
router.get(
  '/:guildId',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀 목록 조회'
    #swagger.description = '길드별 팀 목록을 페이지네이션으로 조회합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호', required: false }
    #swagger.parameters['limit'] = { in: 'query', description: '조회 개수', required: false }
    #swagger.parameters['search'] = { in: 'query', description: '팀명 검색', required: false }
  */
  validateRequest(getTeamsSchema),
  getTeamsByGuild,
);

/**
 * @route POST /api/teams/:guildId/excel
 * @desc 엑셀 파일로 팀 일괄 생성
 */
router.post(
  '/:guildId/excel',
  /* #swagger.tags = ['Team']
    #swagger.summary = '엑셀 팀 일괄 생성'
    #swagger.description = '엑셀 파일을 업로드하여 여러 팀을 한번에 생성합니다. 양식: 첫 열=팀이름, 나머지 열=멤버(닉네임#태그)'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
  */
  upload.single('file'),
  validateRequest(excelUploadSchema),
  createTeamsFromExcel,
);

/**
 * @route GET /api/teams/:guildId/:teamCode
 * @desc 팀 상세 조회
 */
router.get(
  '/:guildId/:teamCode',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀 상세 조회'
    #swagger.description = '팀 코드로 팀 상세 정보와 현재 로스터를 조회합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드 (예: TM_000001)', required: true }
  */
  validateRequest(getTeamByCodeSchema),
  getTeamByCode,
);

/**
 * @route PUT /api/teams/:guildId/:teamCode
 * @desc 팀 이름 수정
 */
router.put(
  '/:guildId/:teamCode',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀 이름 수정'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드', required: true }
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { name: '새 팀이름' }
    }
  */
  validateRequest(updateTeamSchema),
  updateTeam,
);

/**
 * @route DELETE /api/teams/:guildId/:teamCode
 * @desc 팀 삭제
 */
router.delete(
  '/:guildId/:teamCode',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀 삭제'
    #swagger.description = '팀을 소프트 삭제합니다. 팀원도 함께 비활성화됩니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드', required: true }
  */
  validateRequest(deleteTeamSchema),
  deleteTeam,
);

/**
 * @route POST /api/teams/:guildId/:teamCode/members
 * @desc 팀원 추가
 */
router.post(
  '/:guildId/:teamCode/members',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀원 추가'
    #swagger.description = '라이엇 닉네임#태그로 팀원을 추가합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드', required: true }
    #swagger.parameters['body'] = {
      in: 'body',
      required: true,
      schema: { riotName: 'Faker', riotNameTag: 'KR1', position: 'MID' }
    }
  */
  validateRequest(addTeamMemberSchema),
  addTeamMember,
);

/**
 * @route DELETE /api/teams/:guildId/:teamCode/members/:playerCode
 * @desc 팀원 제거
 */
router.delete(
  '/:guildId/:teamCode/members/:playerCode',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀원 제거'
    #swagger.description = '팀원을 비활성화합니다. 탈퇴 이력이 기록됩니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드', required: true }
    #swagger.parameters['playerCode'] = { in: 'path', description: '플레이어 코드 (예: PLR_000001)', required: true }
  */
  validateRequest(removeTeamMemberSchema),
  removeTeamMember,
);

/**
 * @route GET /api/teams/:guildId/:teamCode/members/history
 * @desc 팀원 변경 이력 조회
 */
router.get(
  '/:guildId/:teamCode/members/history',
  /* #swagger.tags = ['Team']
    #swagger.summary = '팀원 변경 이력'
    #swagger.description = '현재 + 이전 팀원의 가입/탈퇴 이력을 조회합니다.'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['teamCode'] = { in: 'path', description: '팀 코드', required: true }
  */
  validateRequest(getTeamMemberHistorySchema),
  getTeamMemberHistory,
);

export default router;
