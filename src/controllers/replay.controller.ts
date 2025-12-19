import { Request, Response, NextFunction } from 'express';
import {
  ReplayResponse,
  ReplayFileRequest,
} from '../types/replay.js';
import { replaySaveFacade } from '../facade/replaySave.facade.js';

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
        const savedReplay = await replaySaveFacade.allSave(fileData);
        return res.status(201).json({
            status: 'success',
            message: 'Replay created successfully',
            data: savedReplay
        });
    } catch (error) { 
      next(error);
    }
};