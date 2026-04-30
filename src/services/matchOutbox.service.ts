import { TransactionType } from '../database/connectionPool.js';
import { matchOutbox, MatchParticipant } from '../database/schema.js';
import { ReplaySaveResult } from '../types/replay.js';
import { SystemError } from '../types/error.js';

interface RawParticipant {
  PUUID: string;
  RIOT_ID_GAME_NAME?: string;
  RIOT_ID_TAG_LINE?: string;
}

interface MatchOutboxParticipant {
  puuid: string;
  player_code: string;
  riot_name: string;
  champion_id: string;
  game_team: string;
  game_result: string;
  position: string;
  kill: number;
  death: number;
  assist: number;
  gold: number;
  total_damage_taken: number;
  vision_score: number;
  cc_time: number;
  time_played: number;
  total_damage_champions: number;
}

interface MatchOutboxPayload {
  custom_match_id: string;
  guild_id: string;
  season: string;
  game_type: string;
  match_date: string;
  participants: MatchOutboxParticipant[];
}

export class MatchOutboxService {
  public async insertMatchOutbox(
    savedReplay: ReplaySaveResult,
    participants: MatchParticipant[],
    rawData: RawParticipant[],
    tx: TransactionType,
  ) {
    try {
      const payload = this.buildMatchOutboxPayload(savedReplay, participants, rawData);

      const [result] = await tx
        .insert(matchOutbox)
        .values({
          customMatchId: savedReplay.replayCode,
          guildId: savedReplay.guildId,
          payload,
        })
        .returning();

      return result;
    } catch (error) {
      console.error('Error inserting MatchOutbox', error);
      throw new SystemError('MatchOutbox error while inserting', 500);
    }
  }

  private buildMatchOutboxPayload(
    savedReplay: ReplaySaveResult,
    participants: MatchParticipant[],
    rawData: RawParticipant[],
  ): MatchOutboxPayload {
    return {
      custom_match_id: savedReplay.replayCode,
      guild_id: savedReplay.guildId,
      season: savedReplay.season,
      game_type: savedReplay.gameType,
      match_date: savedReplay.createDate.toISOString(),
      participants: participants.map((participant, index) => {
        const rawParticipant = rawData[index];

        return {
          puuid: rawParticipant?.PUUID || participant.playerCode,
          player_code: participant.playerCode,
          riot_name: this.buildRiotName(rawParticipant),
          champion_id: participant.championId,
          game_team: participant.gameTeam,
          game_result: participant.gameResult,
          position: participant.position,
          kill: participant.kill,
          death: participant.death,
          assist: participant.assist,
          gold: participant.gold,
          total_damage_taken: participant.totalDamageTaken,
          vision_score: participant.visionScore,
          cc_time: participant.ccing,
          time_played: participant.timePlayed,
          total_damage_champions: participant.totalDamageChampions,
        };
      }),
    };
  }

  private buildRiotName(rawParticipant: RawParticipant | undefined): string {
    if (!rawParticipant) return '';

    const gameName = rawParticipant.RIOT_ID_GAME_NAME || '';
    const tagLine = rawParticipant.RIOT_ID_TAG_LINE || '';

    return tagLine ? `${gameName}#${tagLine}` : gameName;
  }
}

export const matchOutboxService = new MatchOutboxService();
