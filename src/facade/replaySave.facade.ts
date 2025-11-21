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

        // 1. 길드 저장
        await guildService.upsertGuild(fileData.guild, tx);

        // 2. Replay 저장 (원본 데이터)
        const savedReplay = await replayService.replaySave(fileData, rawData, tx);

        // 3. Riot 계정 저장
        await riotAccountService.upsertRiotAccount(rawData, tx);

        // puuid로 player_code 조회
        const riotAccounts = await riotAccountService.findRiotAccountsByPuuids(rawData, tx);

        // 참여자들의 playerCode 목록 추출
        const playerCodes = riotAccounts.map(acc => acc.playerCode);

        // GuildMemberService를 통해 부캐-본캐 연결 정보 조회
        const subAccountLinks = await guildMemberService.findMainAccountsForSubMembers(
          playerCodes,
          savedReplay.guildId,
          tx
        );

        // 빠른 조회를 위해 부캐 코드를 Key로 하는 Map 생성 (부캐코드 -> 본캐코드)
        const subToMainMap = new Map<string, string>();
        subAccountLinks.forEach(link => {
          if (link.mainAccount) {
            subToMainMap.set(link.account, link.mainAccount);
          }
        });

        // 최종 매핑 생성 (Map<PUUID, 본캐PlayerCode>)
        const puuidToPlayerCodeMap = new Map<string, string>();
        
        riotAccounts.forEach((acc) => {
          // 부캐 목록에 있으면 본캐 코드로, 없으면 자기 자신 코드로 매핑
          const targetPlayerCode = subToMainMap.get(acc.playerCode) || acc.playerCode;
          puuidToPlayerCodeMap.set(acc.puuid, targetPlayerCode);
        });

        const customMatchData = {
          id: savedReplay.replayCode,
          gameType: savedReplay.gameType,
          guildId: savedReplay.guildId,
          season: savedReplay.season,
        };

        // 4. 내전 저장
        await customMatchService.insertCustomMatch(customMatchData, tx);

        // 5. 내전 참여자 기록 저장
        await matchParticipantService.insertMatchParticipants(
          rawData, 
          customMatchData.id, 
          tx,
          puuidToPlayerCodeMap
        );

        // 6. 길드 멤버 저장
        await guildMemberService.insertGuildMember(riotAccounts, savedReplay.guildId, tx);

        return savedReplay;
      });
    } catch (err) {
      throw err;
    }

  }
}

export const replaySaveFacade = new ReplaySaveFacade();