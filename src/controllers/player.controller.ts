import { Request, Response } from 'express';
import { eq, ilike, desc, sql, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { player } from '../database/schema.js';
import {
  UpdatePlayerRequest,
  GetPlayersQuery,
  PlayerResponse,
} from '../types/player.js';

/**
 * @desc 계정조회
 * @route
 * @access
 */
export const getPlayerByRiotNameOrTag = async (
  req: Request<{ riotName: string, riotNameTag?: string, guildId: string }>,
  res: Response<PlayerResponse>,
) => {
  try {
    const { riotName, guildId, riotNameTag } = req.params;

    const whereConditions = [
      eq(player.guildId, guildId),
      eq(player.riotName, riotName),
      eq(player.deleteYn, 'N'),
    ];

    if (riotNameTag) {
      whereConditions.push(eq(player.riotNameTag, riotNameTag));
    }

    const playerResult = await db
    .select()
    .from(player)
    .where(and(...whereConditions))
    .limit(1);

    if(playerResult.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'Player not found',
        data: null,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: 'Player retrieved successfully',
      data: playerResult[0],
    });

  } catch (error) {
    console.error('Error retrieving player: ',error );
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error while retrieving player',
      data: null,
    });
  }
};