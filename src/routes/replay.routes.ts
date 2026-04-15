import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { validateRequest } from '../middlewares/validateRequest.js';
import { verifyAuth } from '../middlewares/authHandler.js';
import { decodeGuildIdMiddleware } from '../middlewares/decodeGuildId.js';
import { requireUploadPermission } from '../middlewares/requireRole.js';

import { createReplay, getReplayList, webCreateReplay } from '../controllers/replay.controller.js';

const router: Router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const webCreateReplaySchema = z.object({
  body: z.object({
    guildId: z
      .string()
      .min(1, 'guildId is required')
      .max(128, 'guildId must be less than 128 characters'),
    gameType: z.string().length(1, '게임 타입은 1자여야 합니다.').default('1'),
    nick: z
      .string()
      .min(1, 'nick is required')
      .max(255, 'nick must be less than 255 characters'),
  }),
});

const getReplayListSchema = z.object({
  params: z.object({
    guildId: z.string().min(1, 'guildId is required').max(128),
  }),
  query: z.object({
    page: z.string().regex(/^\d+$/, 'Page must be a positive number').transform(Number).optional(),
    limit: z.string().regex(/^\d+$/, 'Limit must be a positive number').transform(Number)
      .refine((v) => v >= 1 && v <= 10, 'Limit must be between 1 and 10').optional(),
  }).optional(),
});

// TO-DO replay message
const createReplaySchema = z.object({
  body: z.object({
    fileName: z
      .string()
      .min(1, 'File name is required')
      .max(128, 'File name must be less than 128 characters'),
    fileUrl: z.string().max(255, '파일 URL은 255자 이하여야 합니다.'),
    gameType: z.string().length(1, '게임 타입은 1자여야 합니다.').default('1'),
    createUser: z
      .string()
      .min(1, '생성 유저는 필수 입력 사항입니다.')
      .max(255, '생성 유저는 255자 이하여야 합니다.'),
    guild: z.object({
      id: z
        .string()
        .min(1, 'guild Id is required')
        .max(128, 'guild Id must be less than 128 characters'),
      name: z
        .string()
        .min(1, 'guild name is required')
        .max(255, 'guild name must be less than 128 characters'),
      languageCode: z
        .string()
        .max(10, 'languageCode must be less than 10 characters')
        .default('ko'),
    }),
  }),
});

/**
 * @route GET /api/replays/:guildId
 * @desc 길드별 리플레이 목록 조회
 */
router.get(
  '/:guildId',
  /* #swagger.tags = ['Replays']
    #swagger.summary = '리플레이 목록 조회'
    #swagger.description = '길드별 리플레이 목록을 최신순으로 조회합니다. (최대 10개)'
    #swagger.parameters['guildId'] = { in: 'path', description: 'Discord 길드 ID', required: true }
    #swagger.parameters['page'] = { in: 'query', description: '페이지 번호 (기본값: 1)', required: false }
    #swagger.parameters['limit'] = { in: 'query', description: '조회 개수 (1~10, 기본값: 10)', required: false }
  */
  decodeGuildIdMiddleware,
  validateRequest(getReplayListSchema),
  getReplayList,
);

/**
 * @route POST /api/replays
 * @desc 리플레이 파일 저장
 * @access Public 또는 인증 필요
 */
router.post(
  '/',
  /* #swagger.tags = ['Replays']
    #swagger.summary = '리플레이 생성'
    #swagger.description = '리플레이 파일 정보와 길드 정보를 저장합니다.'
    #swagger.parameters['body'] = {
      in: 'body',
      description: '리플레이 및 길드 데이터',
      required: true,
      schema: {
        fileName: 'example.rofl',
        fileUrl: 'https://s3-bucket-url...',
        gameType: '1',
        createUser: 'DiscordUser123',
        guild: {
          id: 'guild_12345',
          name: 'My Awesome Guild',
          languageCode: 'ko'
        }
      }
    }
  */
  validateRequest(createReplaySchema),
  createReplay,
);

/**
 * @route POST /api/replays/web
 * @desc 웹에서 .rofl 리플레이 파일 직접 업로드
 * @access 인증 필요 + 업로드 권한
 */
router.post(
  '/web',
  /* #swagger.tags = ['Replays']
    #swagger.summary = '웹 리플레이 업로드'
    #swagger.description = '웹에서 .rofl 파일을 직접 업로드하여 리플레이를 저장합니다. 최대 10개 파일, 파일당 50MB 제한. 인증 필요 + 업로드 권한 필요 (allowAllUploads=true인 길드는 인증만으로 가능).'
    #swagger.autoBody = false
    #swagger.requestBody = {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              files: {
                type: 'array',
                items: { type: 'string', format: 'binary' },
                description: '.rofl 리플레이 파일 (최대 10개, 파일당 50MB)'
              },
              guildId: {
                type: 'string',
                description: 'Discord 길드(서버) ID',
                example: '123456789012345678'
              },
              gameType: {
                type: 'string',
                description: '게임 타입 (기본값: 1)',
                example: '1'
              },
              nick: {
                type: 'string',
                description: '닉네임',
                example: 'gmokuser/01'
              }
            },
            required: ['files', 'guildId', 'nick']
          }
        }
      }
    }
    #swagger.responses[201] = {
      description: '업로드 처리 완료 (부분 성공 가능)',
      schema: {
        status: 'success',
        message: 'Web replay upload completed',
        data: {
          succeeded: [{ fileName: 'game1.rofl', replayCode: 'RPY-260310-game1-1' }],
          failed: [{ fileName: 'bad.txt', reason: 'invalid_extension' }]
        }
      }
    }
    #swagger.responses[400] = { description: '파일 미첨부 또는 guildId 누락' }
    #swagger.responses[401] = { description: '인증 실패' }
    #swagger.responses[403] = { description: '업로드 권한 부족' }
  */
  verifyAuth,
  upload.array('files', 10),
  validateRequest(webCreateReplaySchema),
  requireUploadPermission({ from: 'body', key: 'guildId' }),
  webCreateReplay,
);

export default router;
