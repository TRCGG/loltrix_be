import { Request, Response } from 'express';
import { mmrService } from '../services/mmr.service.js';
import { PlayerMmrResponse } from '../types/mmr.js';

export const getPlayerMmr = async (
  req: Request,
  res: Response<PlayerMmrResponse | { status: string; message: string }>,
) => {
  try {
    const { puuid } = req.params;
    const guildId = req.query.guildId as string;

    const result = await mmrService.getPlayerMmr(puuid, guildId);

    if (!result) {
      return res.status(404).json({
        status: 'error',
        message: 'Player MMR not found',
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error retrieving player MMR:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving player MMR',
    });
  }
};
