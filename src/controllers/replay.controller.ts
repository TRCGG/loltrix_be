import { Request, Response, NextFunction } from 'express';
import {
  ReplayResponse,
  ReplayFileRequest,
} from '../types/replay.js';
import { replayService } from '../services/replay.service.js';

/**
 * @route POST /api/replays
 * @desc 리플레이 파일 저장 API 
 * @access Public
 */
export const createReplay = async (
  req: Request<Record<string, never>, ReplayResponse, ReplayFileRequest>, 
  res: Response<ReplayResponse>, 
  next: NextFunction
) => {
    const fileData = req.body; 

    try {
        const savedReplay = await replayService.save(fileData);
        return res.status(201).json({
            status: 'success',
            message: 'Replay created successfully',
            data: savedReplay
        });
    } catch (error) { 
      next(error);
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
  try {
    const { replayCode } = req.params;
    if (!replayCode) {
      return res.status(400).json({ status: 'error', message: 'Invalid replay ID' });
    }

    const deletedReplay = await replayService.softDeleteReplayByCode(replayCode);
    if(!deletedReplay) {
      return res.status(404).json({
        status: 'error',
        message: 'Replay not found',
        data: null
      });
    }

    return res.status(200).json({ 
      status: 'success', 
      message: 'Replay deleted successfully', 
      data: deletedReplay 
    });
  } catch (error) {
    console.error('Error deleting replay:', error);
    return res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error while deleting replay',
      data: null
    });
  }
};