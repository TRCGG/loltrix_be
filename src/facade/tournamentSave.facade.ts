import { eq } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { customMatch, matchBan, TournamentCode } from '../database/schema.js';
import { MatchV5Dto } from '../clients/riot/index.js';
import { getMatch } from '../clients/riot/index.js';
import { guildService } from '../services/guild.service.js';
import { riotAccountService } from '../services/riotAccount.service.js';
import { customMatchService } from '../services/customMatch.service.js';
import { matchParticipantService } from '../services/matchParticipant.service.js';
import { mmrMetricService } from '../services/mmrMetric.service.js';
import { guildMemberService } from '../services/guildMember.service.js';
import { matchV5AdapterService } from '../services/matchV5Adapter.service.js';
import { tournamentService } from '../services/tournament.service.js';
import { botNotifyService } from '../services/botNotify.service.js';
import { systemConfigService } from '../services/systemConfig.service.js';
import { SystemError } from '../types/error.js';
import { TournamentCodeMetadata } from '../types/tournament.js';

/** 적재 결과. status로 콜백/폴링이 응답을 구성한다. */
export type TournamentIngestResult =
  | { status: 'ok'; matchId: string; loaded: boolean }
  | { status: 'ignored'; reason: string };

/**
 * @desc 토너먼트코드 경기 적재 파사드.
 *
 * 리플 경로(replaySave.facade)와 **동일한 트랜잭션 순서**를 따른다:
 *   guild 확인 → riot_account upsert → custom_match → match_participant → mmr_participant_metric
 *   → match_ban → tournament_code COMPLETED 전이(+custom_match_id·used_date)
 * 를 **단일 트랜잭션**으로 처리한다. (리플 경로엔 replay 단계가 있으나 코드 경로엔 리플 파일이 없어 생략.)
 *
 * ⚠️ 상태 전이(markCompleted)가 적재와 같은 트랜잭션 안에 있으므로, 적재 실패 시 코드는
 * PENDING으로 롤백되어 폴백 폴링이 다시 회수한다(계획서 단계4 ⚠️ 요건 — COMPLETED 유실 차단).
 *
 * 공통 로직(계정 upsert·부계정 병합 등)은 리플 경로 서비스들을 **import로만** 재사용한다.
 */
export class TournamentSaveFacade {
  /**
   * @desc matchId로 match-v5를 재조회·재검증한 뒤 적재한다(콜백/폴링 공통 진입점).
   *
   * 보안 불변식(기획 §보안): match-v5 info.tournamentCode가 DB 코드와 일치할 때만 적재한다.
   * 페이로드/폴링 응답은 신뢰하지 않고, 이 시점에 Riot에서 받은 match-v5로만 판정한다.
   */
  public async ingestByMatchId(
    code: TournamentCode,
    matchId: string,
  ): Promise<TournamentIngestResult> {
    // Riot에서 match-v5 재조회 (읽기 — 트랜잭션 밖).
    const matchV5 = await getMatch(matchId);

    // 재검증: tournamentCode 대조. 불일치 시 적재하지 않는다.
    if (matchV5.info?.tournamentCode !== code.code) {
      return { status: 'ignored', reason: 'tournament_code_mismatch' };
    }

    const loaded = await this.loadMatch(matchV5, code);

    // 신규 적재 성공 시에만 봇에게 다음 코드 게시를 지시한다(트랜잭션 밖, fire-and-forget).
    // 적재된 코드의 metadata에서 channelId를 꺼내 그 채널로 게시하도록 넘긴다. channelId 없으면 skip.
    // botNotifyService는 절대 throw하지 않으므로 콜백/폴링 응답을 깨지 않는다.
    if (loaded) {
      const meta = (code.metadata ?? null) as TournamentCodeMetadata | null;
      const channelId = meta?.channelId;
      if (channelId) {
        await botNotifyService.notifyNextCode(code.guildId, channelId);
      }
    }

    return { status: 'ok', matchId, loaded };
  }

  /**
   * @desc 검증된 match-v5를 단일 트랜잭션으로 적재한다.
   * @returns loaded=true 신규 적재 / false 이미 적재된 경기(멱등 skip).
   */
  private async loadMatch(matchV5: MatchV5Dto, code: TournamentCode): Promise<boolean> {
    const matchId = matchV5AdapterService.getMatchId(matchV5);
    const guildId = code.guildId;
    const playedDate = matchV5AdapterService.getPlayedDate(matchV5);
    const rawData = matchV5AdapterService.toRawParticipants(matchV5);

    return db.transaction(async (tx: TransactionType) => {
      // 0. 멱등 방어: 같은 matchId가 이미 적재됐으면 재적재하지 않는다.
      //    코드가 아직 PENDING이면(콜백/폴링 중복 등) COMPLETED로만 맞춰준다.
      const existing = await tx
        .select({ id: customMatch.id })
        .from(customMatch)
        .where(eq(customMatch.id, matchId))
        .limit(1);

      if (existing.length > 0) {
        await tournamentService.markCompleted(code.code, matchId, tx);
        return false;
      }

      const season = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');

      // 1. 길드 확인 — 코드 발급 시 이미 존재하는 길드. 없으면 적재 중단(오염 방지).
      const foundGuild = await guildService.findGuildById(guildId);
      if (!foundGuild) {
        throw new SystemError(`Guild not found for tournament code load: ${guildId}`, 500);
      }

      // 2. riot_account upsert + 부계정→본계정 병합 맵 (리플 경로와 동일 절차).
      await riotAccountService.upsertRiotAccount(rawData, tx);

      const rawPuuids = new Set<string>(rawData.map((d) => d.PUUID as string));
      const riotAccounts = await riotAccountService.findRiotAccountsByPuuids(rawData, tx);
      const foundPuuids = new Set(riotAccounts.map((a) => a.puuid));
      const missing = [...rawPuuids].filter((p) => !foundPuuids.has(p));
      if (missing.length > 0) {
        throw new SystemError(
          `Missing riot accounts for PUUIDs: ${missing.join(', ')}. ` +
            `Expected ${rawPuuids.size}, found ${foundPuuids.size}.`,
          500,
        );
      }

      const playerCodes = riotAccounts.map((a) => a.playerCode);
      const subLinks = await guildMemberService.findMainAccountsForSubMembers(
        playerCodes,
        guildId,
        tx,
      );
      const subToMain = new Map<string, string>();
      subLinks.forEach((l) => {
        if (l.mainAccount) subToMain.set(l.account, l.mainAccount);
      });

      const puuidToPlayerCodeMap = new Map<string, string>();
      riotAccounts.forEach((a) => {
        puuidToPlayerCodeMap.set(a.puuid, subToMain.get(a.playerCode) || a.playerCode);
      });

      // 3. custom_match — id는 match-v5 matchId('KR_...'). 리플('RPY-...')과 충돌 없음.
      await customMatchService.insertCustomMatch(
        { id: matchId, gameType: '1', guildId, season },
        tx,
      );

      // 4. match_participant.
      await matchParticipantService.insertMatchParticipants(
        rawData,
        matchId,
        tx,
        puuidToPlayerCodeMap,
      );

      // 5. 길드 멤버 등록 (리플 경로와 동일).
      await guildMemberService.insertGuildMember(riotAccounts, guildId, tx);

      // 6. mmr_participant_metric — played_date=gameStartTimestamp (리플 경로는 업로드 시각).
      const metricRows = await mmrMetricService.buildMetricRows({
        rawData,
        customMatchId: matchId,
        guildId,
        season,
        playedDate,
        puuidToPlayerCodeMap,
      });
      await mmrMetricService.insertMetrics(metricRows, tx);

      // 7. match_ban.
      const banRows = matchV5AdapterService.toBanRows(matchV5, matchId);
      if (banRows.length > 0) {
        await tx.insert(matchBan).values(banRows);
      }

      // 8. tournament_code COMPLETED 전이 + custom_match_id·used_date (같은 트랜잭션).
      await tournamentService.markCompleted(code.code, matchId, tx);

      return true;
    });
  }
}

export const tournamentSaveFacade = new TournamentSaveFacade();
