import { Request, Response } from 'express';
import { statisticsService } from '../services/statistics.service.js';
import { scopeFromQuery } from '../types/matchScope.js';
import {
  StatisticsResponse,
  UserGameStatistic,
  StatisticsRequestQuery,
  ChampionStatistic,
  ChampionStatisticsRequestQuery,
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
    StatisticsRequestQuery
  >,
  res: Response<StatisticsResponse<UserGameStatistic>>,
) => {
  try {
    const { guildId } = req.params;
    const {
      datePreset,
      fromMonth,
      toMonth,
      championName,
      position,
      season,
      sortBy,
      page,
      limit,
      gameType,
    } = req.query;

    const { result, totalCount } = await statisticsService.getUserGameStatistics(guildId, {
      datePreset,
      fromMonth,
      toMonth,
      championName,
      position,
      season,
      sortBy: sortBy || 'totalCount',
      page: Number(page) || 1,
      limit: Number(limit) || (sortBy === 'wilsonScore' ? 5 : 50),
      scope: scopeFromQuery({ gameType }),
    });

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    const defaultLimit = sortBy === 'wilsonScore' ? 5 : 50;
    res.setHeader('X-Limit', (limit ?? defaultLimit).toString());
    res.setHeader(
      'X-Total-Pages',
      Math.ceil(totalCount / (Number(limit) || defaultLimit)).toString(),
    );

    return res.status(200).json({
      status: 'success',
      message: 'User game statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving user game stats:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving user game stats',
      data: null,
    });
  }
};

/**
 * @desc 챔피언별 통계 조회
 * @route GET /api/statistics/:guildId/champions
 */
export const getChampionStats = async (
  req: Request<
    { guildId: string },
    StatisticsResponse<ChampionStatistic>,
    Record<string, never>,
    ChampionStatisticsRequestQuery
  >,
  res: Response<StatisticsResponse<ChampionStatistic>>,
) => {
  try {
    const { guildId } = req.params;
    const { datePreset, fromMonth, toMonth, position, season, sortBy, page, limit, gameType } =
      req.query;
    const defaultLimit = sortBy === 'pickRate' || sortBy === 'wilsonScore' ? 5 : 20;

    const { result, totalCount } = await statisticsService.getChampionStatistics(guildId, {
      datePreset,
      fromMonth,
      toMonth,
      position,
      season,
      sortBy: sortBy || 'totalCount',
      page: Number(page) || 1,
      limit: Number(limit) || defaultLimit,
      scope: scopeFromQuery({ gameType }),
    });

    res.setHeader('X-Total-Count', totalCount.toString());
    res.setHeader('X-Page', (page ?? 1).toString());
    res.setHeader('X-Limit', (limit ?? defaultLimit).toString());
    res.setHeader(
      'X-Total-Pages',
      Math.ceil(totalCount / (Number(limit) || defaultLimit)).toString(),
    );

    return res.status(200).json({
      status: 'success',
      message: 'Champion statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    console.error('Error retrieving champion stats:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving champion stats',
      data: null,
    });
  }
};
