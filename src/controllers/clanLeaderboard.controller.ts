import { Request, Response, NextFunction } from 'express';
import { clanLeaderboardService } from '../services/clanLeaderboard.service.js';
import { clanLeaderboardMetricsService } from '../services/clanLeaderboardMetrics.service.js';
import { LeaderboardDatePreset } from '../database/clanLeaderboardPeriod.js';
import { statisticsService } from '../services/statistics.service.js';
import { DailyCache } from '../utils/dailyCache.js';

export const clanLeaderboardCache = new DailyCache(12, 1000);

const cached = <T>(resource: string, guildId: string, options: unknown, load: () => Promise<T>) =>
  clanLeaderboardCache.get(JSON.stringify([resource, guildId, options]), load);

const periodOptions = (req: Request) => ({
  datePreset: req.query.datePreset as LeaderboardDatePreset | undefined,
  fromMonth: req.query.fromMonth as string | undefined,
  toMonth: req.query.toMonth as string | undefined,
  season: req.query.season as string | undefined,
});

const paginationOptions = (req: Request) => ({
  page: Number(req.query.page) || 1,
  limit: Number(req.query.limit) || 5,
});

const setPagination = (res: Response, totalCount: number, page: number, limit: number) => {
  res.setHeader('X-Total-Count', totalCount.toString());
  res.setHeader('X-Page', page.toString());
  res.setHeader('X-Limit', limit.toString());
  res.setHeader('X-Total-Pages', Math.ceil(totalCount / limit).toString());
};

/**
 * @desc 선택한 기간의 본캐 유저 전적 순위를 페이지와 함께 반환합니다.
 */
export const getClanLeaderboardUsers = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const options = {
      ...periodOptions(req),
      ...paginationOptions(req),
      position: req.query.position as string | undefined,
      championName: req.query.championName as string | undefined,
      sortBy: (req.query.sortBy || 'totalCount') as 'totalCount' | 'wilsonScore',
    };
    const { guildId } = req.params;
    const { result, totalCount } = await cached('users', guildId, options, () =>
      statisticsService.getClanLeaderboardUserStatistics(guildId, options),
    );
    setPagination(res, totalCount, options.page, options.limit);
    return res.status(200).json({
      status: 'success',
      message: 'User game statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 선택한 기간의 챔피언 픽률 또는 Wilson 순위를 페이지와 함께 반환합니다.
 */
export const getClanLeaderboardChampions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const options = {
      ...periodOptions(req),
      ...paginationOptions(req),
      position: req.query.position as string | undefined,
      sortBy: (req.query.sortBy || 'pickRate') as 'pickRate' | 'wilsonScore',
    };
    const { guildId } = req.params;
    const { result, totalCount } = await cached('champions', guildId, options, () =>
      statisticsService.getClanLeaderboardChampionStatistics(guildId, options),
    );
    setPagination(res, totalCount, options.page, options.limit);
    return res.status(200).json({
      status: 'success',
      message: 'Champion statistics retrieved successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * @desc 선택한 기간의 같은 팀 챔피언 조합 순위를 페이지와 함께 반환합니다.
 */
export const getChampionCombinations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = paginationOptions(req);
    const { guildId } = req.params;
    const options = {
      ...periodOptions(req),
      page,
      limit,
      combination: req.query.combination as 'ADCSUP' | 'MIDJUG',
    };
    const { result, totalCount } = await cached('combinations', guildId, options, () =>
      clanLeaderboardService.getChampionCombinations(guildId, options),
    );
    setPagination(res, totalCount, page, limit);
    return res.status(200).json({
      status: 'success',
      message: 'Champion combinations retrieved successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc 선택한 기간에 함께한 듀오의 경기 수 순위를 페이지와 함께 반환합니다.
 */
export const getDuos = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = paginationOptions(req);
    const { guildId } = req.params;
    const options = { ...periodOptions(req), page, limit };
    const { result, totalCount } = await cached('duos', guildId, options, () =>
      clanLeaderboardService.getDuos(guildId, options),
    );
    setPagination(res, totalCount, page, limit);
    return res
      .status(200)
      .json({ status: 'success', message: 'Duos retrieved successfully', data: result });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc 선택한 기간의 내전 규모와 일별 경기 수를 반환합니다.
 */
export const getActivity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { guildId } = req.params;
    const options = periodOptions(req);
    const data = await cached('activity', guildId, options, () =>
      clanLeaderboardService.getActivity(guildId, options),
    );
    return res
      .status(200)
      .json({ status: 'success', message: 'Clan activity retrieved successfully', data });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc 최근 30일과 직전 30일을 비교한 승률 상승세 상위 5명을 반환합니다.
 */
export const getRisingStars = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { guildId } = req.params;
    const season = req.query.season as string | undefined;
    const data = await cached('rising-stars', guildId, { season }, () =>
      clanLeaderboardMetricsService.getRisingStars(guildId, season),
    );
    return res.status(200).json({
      status: 'success',
      message: 'Rising stars retrieved successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc 최근 30일 내전의 공동 최고 기록과 펜타킬 기록을 반환합니다.
 */
export const getHighlights = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { guildId } = req.params;
    const season = req.query.season as string | undefined;
    const data = await cached('highlights', guildId, { season }, () =>
      clanLeaderboardMetricsService.getHighlights(guildId, season),
    );
    return res.status(200).json({
      status: 'success',
      message: 'Highlights retrieved successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc 최근 30일 내전의 현재 연승 상위 5명을 반환합니다.
 */
export const getWinStreaks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { guildId } = req.params;
    const season = req.query.season as string | undefined;
    const data = await cached('win-streaks', guildId, { season }, () =>
      clanLeaderboardMetricsService.getWinStreaks(guildId, season),
    );
    return res.status(200).json({
      status: 'success',
      message: 'Win streaks retrieved successfully',
      data,
    });
  } catch (error) {
    next(error);
  }
};
