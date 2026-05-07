import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { mmrHistory, playerMmr } from '../database/schema.js';
import { PlayerMmrResponse } from '../types/mmr.js';

export class MmrService {
  public async getPlayerMmr(puuid: string, guildId: string): Promise<PlayerMmrResponse | null> {
    const [result] = await db
      .select({
        puuid: playerMmr.puuid,
        guildId: playerMmr.guildId,
        mmr: playerMmr.mmr,
        gamesPlayed: playerMmr.gamesPlayed,
        wins: playerMmr.wins,
        losses: playerMmr.losses,
        lastMatchId: playerMmr.lastMatchId,
        lastUpdated: playerMmr.updateDate,
        lastMatchDelta: mmrHistory.delta,
        winRate: sql<number>`
          CASE
            WHEN ${playerMmr.gamesPlayed} = 0 THEN 0
            ELSE ROUND((${playerMmr.wins}::numeric * 100.0) / NULLIF(${playerMmr.gamesPlayed}, 0), 1)
          END
        `,
      })
      .from(playerMmr)
      .leftJoin(
        mmrHistory,
        and(
          eq(mmrHistory.customMatchId, playerMmr.lastMatchId),
          eq(mmrHistory.puuid, playerMmr.puuid),
          eq(mmrHistory.guildId, playerMmr.guildId),
        ),
      )
      .where(
        and(
          eq(playerMmr.puuid, puuid),
          eq(playerMmr.guildId, guildId),
          eq(playerMmr.isDeleted, false),
        ),
      )
      .limit(1);

    if (!result) {
      return null;
    }

    return {
      puuid: result.puuid,
      guildId: result.guildId,
      mmr: result.mmr,
      lastMatchDelta: result.lastMatchDelta,
      lastMatchId: result.lastMatchId,
      gamesPlayed: result.gamesPlayed,
      wins: result.wins,
      losses: result.losses,
      winRate: Number(result.winRate),
      lastUpdated: result.lastUpdated.toISOString(),
    };
  }

  public async getGuildRanking(guildId: string, limit: number) {
    return db
      .select({
        rank: sql<number>`RANK() OVER (ORDER BY ${playerMmr.mmr} DESC)::integer`,
        puuid: playerMmr.puuid,
        mmr: playerMmr.mmr,
        gamesPlayed: playerMmr.gamesPlayed,
        wins: playerMmr.wins,
        losses: playerMmr.losses,
        winRate: sql<number>`
          CASE
            WHEN ${playerMmr.gamesPlayed} = 0 THEN 0
            ELSE ROUND((${playerMmr.wins}::numeric * 100.0) / NULLIF(${playerMmr.gamesPlayed}, 0), 1)
          END
        `,
      })
      .from(playerMmr)
      .where(and(eq(playerMmr.guildId, guildId), eq(playerMmr.isDeleted, false)))
      .orderBy(desc(playerMmr.mmr))
      .limit(limit);
  }

  public async getPlayerMmrHistory(puuid: string, guildId: string, limit: number) {
    return db
      .select({
        customMatchId: mmrHistory.customMatchId,
        preMmr: mmrHistory.preMmr,
        postMmr: mmrHistory.postMmr,
        delta: mmrHistory.delta,
        gameResult: mmrHistory.gameResult,
        position: mmrHistory.position,
        playedAt: mmrHistory.createDate,
      })
      .from(mmrHistory)
      .where(and(eq(mmrHistory.puuid, puuid), eq(mmrHistory.guildId, guildId)))
      .orderBy(desc(mmrHistory.createDate))
      .limit(limit);
  }
}

export const mmrService = new MmrService();
