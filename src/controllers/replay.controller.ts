import { Request, Response, NextFunction } from 'express';
import {
  ReplayResponse,
  ReplayFileRequest,
} from '../types/replay.js';
import { messageService } from '../services/message.service.js';
import { ReplayService } from '../services/replay.service.js';
import { CustomError } from '../utils/customError.util.js';

const replayService = new ReplayService(messageService);

/**
 * @route POST /api/replays
 * @desc 리플레이 파일 저장 API 
 * @access Public
 */
export const createReplay = async (
  req: Request<Record<string, never>, ReplayResponse, ReplayFileRequest>,
  res: Response<ReplayResponse>,
) => {
  const fileData = req.body;
  const locale = req.locale || 'ko';
  try {
    const savedReplay = await replayService.save(fileData, locale);
    return res.status(201).json({
      status: 'success',
      message:
        (await messageService.getMessage(locale, 'replay_save_success')) ||
        'Replay created successfully',
      data: savedReplay,
    });
  } catch (error) {
    if (error instanceof CustomError) {
      if (error.status === 409) {
        return res.status(409).json({
          status: 'error',
          message: error.message,
          data: null,
        });
      }
    }

    return res.status(500).json({
      status: 'error',
      message:
        (await messageService.getMessage(locale, 'replay_save_error500')) ||
        'Internal server error while creating Replay',
      data: null,
    });
  }
};

/**
 * @desc 리플레이를 논리적으로 삭제
 * @route DELETE /api/replays/:replayCode
 * @access Public
 */
export const softDeleteReplay = async (
  req: Request<{ replayCode: string }>, 
  res: Response<ReplayResponse>
) => {
  const locale = req.locale || 'ko';
  const { replayCode } = req.params;

  try {
    const deletedReplay = await replayService.softDeleteReplayByCode(replayCode);
    if(!deletedReplay) {
      return res.status(404).json({
        status: 'error',
        message: 
        (await messageService.getMessage(locale, 'replay_common_error404')) ||
        'Replay not found',
        data: null
      });
    }

    return res.status(200).json({ 
      status: 'success', 
      message: 
      (await messageService.getMessage(locale, 'replay_delete_success')) ||
      'Replay deleted successfully', 
      data: deletedReplay 
    });
  } catch (error) {
    console.error('Error deleting replay:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: 
      (await messageService.getMessage(locale, 'replay_delete_error500')) ||
      'Internal server error while deleting replay',
      data: null
    });
  }
};