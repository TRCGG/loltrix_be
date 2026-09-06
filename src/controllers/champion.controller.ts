import { Request, Response } from 'express';
import { ChampionListAPIResponse } from '../types/champion.js';
import { championService } from '../services/champion.service.js';

/**
 * @desc 챔피언 목록 조회
 * @route GET /api/champions
 * @access 세션 로그인
 */
export const getChampions = async (req: Request, res: Response<ChampionListAPIResponse>) => {
  try {
    const champions = await championService.getAll();

    return res.status(200).json({
      status: 'success',
      message: 'Champions retrieved successfully',
      data: champions,
    });
  } catch (error) {
    console.error('Error retrieving champions:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving champions',
      data: null,
    });
  }
};
