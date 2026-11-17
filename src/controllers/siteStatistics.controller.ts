import { Request, Response, NextFunction } from 'express';
import { siteStatisticsService } from '../services/siteStatistics.service.js';
import { DailyCache } from '../utils/dailyCache.js';

export const siteOverviewCache = new DailyCache(12, 1);

/**
 * @desc 사이트 전체 이용현황(클랜·경기·플레이어 수)을 반환합니다.
 */
export const getSiteOverview = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await siteOverviewCache.get('overview', () => siteStatisticsService.getOverview());
    return res.status(200).json({
      status: 'success',
      message: 'Site overview retrieved successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};
