import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { tournamentService } from '../services/tournament.service.js';
import { IssueCodesRequest } from '../types/tournament.js';

/**
 * @desc 토너먼트 코드 발급 (봇/웹 공용). count개 선발급 → tournament_code INSERT(PENDING).
 * 봇(localhost)은 channelId를 보내 콜백 시 다음 코드 게시 대상을 지정하고,
 * 웹 세션(guildManager 이상)은 channelId 없이 발급 — issuedBy로 발급자를 남긴다.
 * @route POST /api/tournament/codes
 */
export const issueCodes = async (
  req: Request<unknown, unknown, IssueCodesRequest>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { guildId, channelId, count } = req.body;
    const auth = req as AuthRequest;

    const codes = await tournamentService.issueCodes({
      guildId,
      channelId,
      count,
      source: auth.isBot ? 'BOT' : 'WEB',
      issuedBy: auth.discordMemberId,
    });

    return res.status(201).json({
      status: 'success',
      message: 'Tournament codes issued successfully',
      data: { codes },
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 미사용 다음 코드 조회 (봇 !다음코드 용). PENDING 중 issued_date 오름차순 첫 코드.
 * @route GET /api/tournament/next-code?guildId=...
 */
export const getNextCode = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const guildId = req.query.guildId as string;

    const code = await tournamentService.getNextCode(guildId);

    if (!code) {
      return res.status(404).json({
        status: 'error',
        message: '발급된 미사용 코드가 없습니다.',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Next tournament code retrieved successfully',
      data: code,
    });
  } catch (error) {
    return next(error);
  }
};
