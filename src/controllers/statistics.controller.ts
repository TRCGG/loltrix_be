import { Request, Response } from 'express';
import { statisticsService } from '../services/statistics.service.js';
import {
  StatisticsResponse,
  UserGameStatistic,
  GetStatisticsQuery,
  ChampionStatistic,
} from '../types/statistics.js';

/**
 * @desc 유저별 게임 통계 조회
 * @route GET /api/statistics/:guildId/users
 */
export const getUserGameStats = async (
  req: Request<
    { guildId: string },
    StatisticsResponse<UserGameStatistic>,
    Record<string, never>,
    GetStatisticsQuery
  >,
  res: Response<StatisticsResponse<UserGameStatistic>>,
) => {
  try {
    const { guildId } = req.params;
    const { year, month, championName, position, season, sortBy, page, limit } = req.query;

    const { result, totalCount } = await statisticsService.getUserGameStatistics(
      guildId,
      year,
      month,
      championName,
      position,
      season,
      (sortBy as 'totalCount' | 'winRate') || 'totalCount',
      Number(page) || 1,
      Number(limit) || 50,
    );

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    res.setHeader('X-Limit', (limit ?? 50).toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / (Number(limit) ?? 50)).toString());

    return res.status(200).json({
      status: 'success',
      message: 'User game statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving user game stats:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving user game stats',
      data: null,
    });
  }
};

/**
 * @desc 챔피언별 통계 조
 * @route GET /api/statistics/:guildId/champions
 */
export const getChampionStats = async (
  req: Request<
    { guildId: string },
    StatisticsResponse<ChampionStatistic>,
    Record<string, never>,
    GetStatisticsQuery
  >,
  res: Response<StatisticsResponse<ChampionStatistic>>,
) => {
  try {
    const { guildId } = req.params;
    const { year, month, position, season, sortBy, page, limit } = req.query;

    const { result, totalCount } = await statisticsService.getChampionStatistics(
      guildId,
      year,
      month,
      position,
      season,
      (sortBy as 'totalCount' | 'winRate') || 'totalCount',
      Number(page) || 1,
      Number(limit) || 20,
    );

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    res.setHeader('X-Limit', (limit ?? 50).toString());
    res.setHeader('X-Total-Pages', Math.ceil(totalCount / (Number(limit) ?? 50)).toString());

    return res.status(200).json({
      status: 'success',
      message: 'Champion statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving champion stats:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving champion stats',
      data: null,
    });
  }
};
