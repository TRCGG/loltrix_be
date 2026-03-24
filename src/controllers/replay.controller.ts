import { Request, Response, NextFunction } from 'express';
import { ReplayResponse, ReplayFileRequest, WebUploadResponse, ReplayListResponse, GetReplaysQuery } from '../types/replay.js';
import { replaySaveFacade } from '../facade/replaySave.facade.js';
import { replayService } from '../services/replay.service.js';
import { AuthRequest } from '../middlewares/authHandler.js';

/**
 * @route POST /api/replays
 * @desc 리플레이 파일 저장 API
 * @access Public
 */
export const createReplay = async (
  req: Request<Record<string, never>, ReplayResponse, ReplayFileRequest>,
  res: Response<ReplayResponse>,
  next: NextFunction,
) => {
  const fileData = req.body;

  try {
    const savedReplay = await replaySaveFacade.allSave(fileData);
    return res.status(201).json({
      status: 'success',
      message: 'Replay created successfully',
      data: savedReplay,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route GET /api/replays/:guildId
 * @desc 길드별 리플레이 목록 조회
 */
export const getReplayList = async (
  req: Request<{ guildId: string }, ReplayListResponse, Record<string, never>, GetReplaysQuery>,
  res: Response<ReplayListResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params;
    const { page = 1, limit = 10 } = req.query;

    const { result, totalCount } = await replayService.findReplaysByGuild(guildId, Number(page), Number(limit));

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', page.toString());
    res.setHeader('X-Limit', limit.toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / Number(limit)).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Replays retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @route POST /api/replays/web
 * @desc 웹에서 .rofl 파일 직접 업로드
 */
export const webCreateReplay = async (
  req: AuthRequest,
  res: Response<WebUploadResponse>,
  next: NextFunction,
) => {
  try {
    const { guildId, gameType, nick } = req.body as { guildId: string; gameType?: string; nick: string; };
    const files = Array.isArray(req.files) ? req.files : [];

    if (files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No files uploaded' });
    }

    const succeeded: Array<{ fileName: string; replayCode: string }> = [];
    const failed: Array<{ fileName: string; reason: string }> = [];

    for (const file of files) {
      const originalName = file.originalname;

      // 1. 확장자 검증 (.rofl)
      if (!originalName.toLowerCase().endsWith('.rofl')) {
        failed.push({ fileName: originalName, reason: 'invalid_extension' });
        continue;
      }

      const fileName = originalName
        .replace(/\.rofl$/i, '')
        .replace(/\s+/g, '_');

      // 2. Magic bytes 검증 ("RIOT")
      if (!replayService.validateMagicBytes(file.buffer)) {
        failed.push({ fileName, reason: 'invalid_format' });
        continue;
      }

      // 3. 리플레이 데이터 파싱
      let rawData: any[];
      try {
        const rawDataString = await replayService.parseReplayData(file.buffer);
        rawData = JSON.parse(rawDataString);
      } catch {
        failed.push({ fileName, reason: 'parse_failed' });
        continue;
      }

      // 4. 중복 해시 체크
      const hashData = replayService.generateHash(JSON.stringify(rawData));
      if (await replayService.checkDuplicateByHash(hashData, guildId)) {
        failed.push({ fileName, reason: 'duplicated replay data' });
        continue;
      }

      // 5. 저장
      try {
        const savedReplay = await replaySaveFacade.webSave(rawData, fileName, guildId, gameType, nick);
        succeeded.push({ fileName, replayCode: savedReplay.replayCode });
      } catch {
        failed.push({ fileName, reason: 'save_failed' });
      }
    }

    return res.status(201).json({
      status: 'success',
      message: 'Web replay upload completed',
      data: { succeeded, failed },
    });
  } catch (error) {
    return next(error);
  }
};