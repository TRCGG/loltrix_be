import { Request, Response, NextFunction } from 'express';
import { clanLeaderboardService } from '../services/clanLeaderboard.service.js';
import { DatePreset } from '../database/datePeriod.js';

const periodOptions = (req: Request) => ({
  datePreset: req.query.datePreset as DatePreset | undefined,
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

export const getChampionCombinations = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = paginationOptions(req);
    const { result, totalCount } = await clanLeaderboardService.getChampionCombinations(
      req.params.guildId,
      {
        ...periodOptions(req),
        page,
        limit,
        combination: req.query.combination as 'ADCSUP' | 'MIDJUG',
      },
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

export const getDuos = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page, limit } = paginationOptions(req);
    const { result, totalCount } = await clanLeaderboardService.getDuos(req.params.guildId, {
      ...periodOptions(req),
      page,
      limit,
    });
    setPagination(res, totalCount, page, limit);
    return res
      .status(200)
      .json({ status: 'success', message: 'Duos retrieved successfully', data: result });
  } catch (error) {
    next(error);
  }
};

export const getActivity = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = await clanLeaderboardService.getActivity(req.params.guildId, periodOptions(req));
    return res
      .status(200)
      .json({ status: 'success', message: 'Clan activity retrieved successfully', data });
  } catch (error) {
    next(error);
  }
};
