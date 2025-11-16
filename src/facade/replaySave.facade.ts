import { db, TransactionType  } from '../database/connectionPool.js';
import { guildService } from'../services/guild.service.js';
import { replayService } from '../services/replay.service.js';
import { riotAccountService } from '../services/riotAccount.service.js';
import { customMatchService } from '../services/customMatch.service.js';
import { matchParticipantService } from '../services/matchParticipant.service.js';
import { Replay, ReplayFileRequest } from '../types/replay.js';
import { guildMemberService } from '../services/guildMember.service.js';

/**
 * @desc 여러 저장 Service 로직 관리
 */
export class ReplaySaveFacade {

  /**
   * 리플레이 업로드 시작으로 replay, guild, riot_account, custom_match, match_participants, 
   * guild_member 저장 로직 / 하나라도 실패시 전체 rollback
   */
  public async allSave (fileData: ReplayFileRequest): Promise<Replay> {
    try {
      return await db.transaction(async (tx: TransactionType) => {
        const rawData = await replayService.getRawData(fileData);
        
        // 길드 저장
        await guildService.upsertGuild(fileData.guild, tx);
        
        // Replay 저장 (원본 데이터)
        const savedReplay = await replayService.replaySave(fileData, rawData, tx);

        // Riot 계정 저장
        await riotAccountService.upsertRiotAccount(rawData, tx);

        // puuid로 player_code 조회
        const riotAccounts = await riotAccountService.findRiotAccountsByPuuids(rawData, tx);

        const customMatchData = {
          id: savedReplay.replayCode,
          gameType: savedReplay.gameType,
          guildId: savedReplay.guildId,
          season: savedReplay.season
        }
        
        // 내전 저장
        await customMatchService.insertCustomMatch(customMatchData, tx);

        // 내전 참여자 기록 저장 
        await matchParticipantService.insertMatchParticipants(rawData, customMatchData.id, tx);

        // 길드 멤버 저장
        await guildMemberService.insertGuildMember(
          riotAccounts,
          savedReplay.guildId,
          tx
        );

        return savedReplay;
      });
    } catch (err) {
      throw err;
    }

  }
}

export const replaySaveFacade = new ReplaySaveFacade();