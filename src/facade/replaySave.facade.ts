import { db, TransactionType  } from '../database/connectionPool.js';
import { guildService } from'../services/guild.service.js';
import { replayService } from '../services/replay.service.js';
import { riotAccountService } from '../services/riotAccount.service.js';
import { ReplayFileRequest } from '../types/replay.js';

/**
 * @desc 여러 저장 Service 로직 관리
 */
export class ReplaySaveFacade {

  /**
   * 리플레이 업로드 시작으로 replay, guild, riot_account, custom_match, match_participants, 
   * guild_member 저장 로직 / 하나라도 실패시 전체 rollback
   */
  public async allSave (fileData: ReplayFileRequest) {
    
    try {
      const result = await db.transaction(async (tx: TransactionType) => {
        const rawDatas = await replayService.getRawDataes(fileData);
        
        const guildResult = await guildService.upsertGuild(fileData.guild, tx);
        const savedReplay = await replayService.replaySave(fileData, rawDatas, tx);
        const riotAccountResult = await riotAccountService.upsertRiotAccount(rawDatas, tx);
        console.log(riotAccountResult);

        return "";
      });
    } catch (err) {
      throw err;
    }

  }
}

export const replaySaveFacade = new ReplaySaveFacade();