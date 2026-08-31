import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { competitionService } from '../services/competition.service.js';
import {
  CompetitionActor,
  CompetitionDetail,
  CompetitionResolveResult,
  CompetitionResponse,
  CompetitionStatus,
  CompetitionSummary,
} from '../types/competition.js';
import { Competition } from '../database/schema.js';

/**
 * 행위자: 웹은 세션 memberId, 봇은 body.actorMemberId(명령 사용자) — 미전달이면 'bot'.
 * 봇 요청은 requireGuildRole을 통과하므로 권한 검사는 봇이 책임진다.
 */
const resolveActor = (req: AuthRequest): CompetitionActor => {
  const bodyActor = (req.body as { actorMemberId?: unknown } | undefined)?.actorMemberId;
  return req.isBot
    ? { memberId: typeof bodyActor === 'string' && bodyActor ? bodyActor : 'bot', source: 'bot' }
    : { memberId: req.discordMemberId ?? 'unknown', source: 'web' };
};

/** @route POST /api/competitions/:guildId */
export const createCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { name } = req.body as { name: string };
    const created = await competitionService.create(guildId, name, resolveActor(req));
    return res
      .status(201)
      .json({ status: 'success', message: 'Competition created successfully', data: created });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId */
export const listCompetitions = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionSummary[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { season, status } = req.query as { season?: string; status?: CompetitionStatus };
    const data = await competitionService.list(guildId, { season, status });
    return res
      .status(200)
      .json({ status: 'success', message: 'Competitions retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/resolve?name= */
export const resolveCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionResolveResult>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { name } = req.query as { name?: string };
    const data = await competitionService.resolveByName(guildId, name);
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition resolved', data });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId */
export const getCompetitionDetail = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionDetail>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const data = await competitionService.getDetail(guildId, Number(competitionId));
    if (!data) {
      return res.status(404).json({ status: 'error', message: 'Competition not found', data: null });
    }
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition detail retrieved successfully', data });
  } catch (error) {
    return next(error);
  }
};

/** @route PATCH /api/competitions/:guildId/:competitionId/close */
export const closeCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const closed = await competitionService.close(guildId, Number(competitionId), resolveActor(req));
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition closed successfully', data: closed });
  } catch (error) {
    return next(error);
  }
};

/** @route DELETE /api/competitions/:guildId/:competitionId */
export const deleteCompetition = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<Competition>>,
  next: NextFunction,
) => {
  try {
    const { guildId, competitionId } = req.params as { guildId: string; competitionId: string };
    const removed = await competitionService.remove(guildId, Number(competitionId), resolveActor(req));
    return res
      .status(200)
      .json({ status: 'success', message: 'Competition deleted successfully', data: removed });
  } catch (error) {
    return next(error);
  }
};
