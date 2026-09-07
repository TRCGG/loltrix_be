import { NextFunction, Response } from 'express';
import { AuthRequest } from '../middlewares/authHandler.js';
import { competitionService } from '../services/competition.service.js';
import { statisticsService } from '../services/statistics.service.js';
import { CompetitionResponse } from '../types/competition.js';
import { ChampionStatistic, CompetitionUserStat } from '../types/statistics.js';
import { scopeFromQuery } from '../types/matchScope.js';

interface CompetitionStatsQuery {
  position?: string;
  sortBy?: 'totalCount' | 'winRate';
  page?: string;
  limit?: string;
  gameType?: string;
}

const DEFAULT_USER_LIMIT = 50;
const DEFAULT_CHAMPION_LIMIT = 20;

const setPageHeaders = (
  res: Response,
  { totalCount, page, limit }: { totalCount: number; page: number; limit: number },
) => {
  res.setHeader('X-Total-Count', totalCount.toString());
  res.setHeader('X-Page', page.toString());
  res.setHeader('X-Limit', limit.toString());
  res.setHeader('X-Total-Pages', Math.ceil(totalCount / limit).toString());
};

const readQuery = (req: AuthRequest, defaultLimit: number) => {
  const { competitionId } = req.params as { competitionId: string };
  const { position, sortBy, page, limit, gameType } = req.query as CompetitionStatsQuery;
  const id = Number(competitionId);

  return {
    id,
    position,
    sortBy: sortBy ?? ('totalCount' as const),
    page: Number(page) || 1,
    limit: Number(limit) || defaultLimit,
    gameTypes: scopeFromQuery({ gameType, competitionId: id }).gameTypes,
  };
};

/** @route GET /api/competitions/:guildId/:competitionId/statistics/users */
export const getCompetitionUserStats = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<CompetitionUserStat[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { id, position, sortBy, page, limit, gameTypes } = readQuery(req, DEFAULT_USER_LIMIT);
    await competitionService.assertExists(guildId, id);

    const { result, totalCount } = await statisticsService.getUserGameStatistics(guildId, {
      position,
      sortBy,
      page,
      limit,
      scope: { gameTypes, competitionId: id },
    });

    setPageHeaders(res, { totalCount, page, limit });

    return res.status(200).json({
      status: 'success',
      message: 'Competition user statistics retrieved successfully',
      // 대회 범위에서만 지표 7개가 실려 오므로 서비스의 일반 반환 타입보다 좁다.
      data: result as CompetitionUserStat[],
    });
  } catch (error) {
    return next(error);
  }
};

/** @route GET /api/competitions/:guildId/:competitionId/statistics/champions */
export const getCompetitionChampionStats = async (
  req: AuthRequest,
  res: Response<CompetitionResponse<ChampionStatistic[]>>,
  next: NextFunction,
) => {
  try {
    const { guildId } = req.params as { guildId: string };
    const { id, position, sortBy, page, limit, gameTypes } = readQuery(req, DEFAULT_CHAMPION_LIMIT);
    await competitionService.assertExists(guildId, id);

    const { result, totalCount } = await statisticsService.getChampionStatistics(guildId, {
      position,
      sortBy,
      page,
      limit,
      scope: { gameTypes, competitionId: id },
    });

    setPageHeaders(res, { totalCount, page, limit });

    return res.status(200).json({
      status: 'success',
      message: 'Competition champion statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};
