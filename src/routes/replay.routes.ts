import { Router } from 'express';
import { z } from 'zod';
import { validateRequest } from '../middlewares/validateRequest.js';

import { 
  createReplay,
  softDeleteReplay

 } from '../controllers/replay.controller.js';

const router = Router();

// TO-DO replay message
const createReplaySchema = z.object({
  body: z.object({
    fileName: z
      .string()
      .min(1, 'File name is required')
      .max(128, 'File name must be less than 128 characters'),
    fileUrl: z
      .string()
      .max(255, '파일 URL은 255자 이하여야 합니다.'),
    gameType: z
      .string()
      .length(1, '게임 타입은 1자여야 합니다.')
      .default('1'),
    createUser: z
      .string()
      .min(1, '생성 유저는 필수 입력 사항입니다.')
      .max(255, '생성 유저는 255자 이하여야 합니다.'),
    guild: z
      .object(
        {
          id: z.string()
          .min(1, 'guild Id is required')
          .max(128, 'guild Id must be less than 128 characters'),
          name: z.string()
          .min(1, 'guild name is required')
          .max(255, 'guild name must be less than 128 characters'),
          languageCode: z.string()
          .max(10, 'languageCode must be less than 10 characters')
          .default('ko')
        }
      )
  }),
});

const deleteReplaySchema = z.object({
  params: z.object({
    replayCode: z
      .string()
      .min(1, 'Replay code is required')
      .max(255, 'Replay code must be less than 255 characters'),
  }),
});


/**
 * @route POST /api/replay/save
 * @desc 리플레이 파일 저장
 * @access Public 또는 인증 필요
 */
router.post('/', validateRequest(createReplaySchema), createReplay);

router.delete('/:replayCode', validateRequest(deleteReplaySchema), softDeleteReplay);

export default router;