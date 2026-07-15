import { eq } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { matchV5Raw, TournamentCode } from '../database/schema.js';
import { MatchTimelineDto, MatchV5Dto } from '../clients/riot/index.js';
import { getMatch, getMatchTimeline } from '../clients/riot/index.js';
import { guildService } from '../services/guild.service.js';
import { tournamentService } from '../services/tournament.service.js';
import { botNotifyService } from '../services/botNotify.service.js';
import { SystemError } from '../types/error.js';
import { TournamentCodeMetadata } from '../types/tournament.js';

/** 적재 결과. status로 콜백/폴링이 응답을 구성한다. */
export type TournamentIngestResult =
  | { status: 'ok'; matchId: string; loaded: boolean }
  | { status: 'ignored'; reason: string };

/**
 * @desc 토너먼트코드 경기 적재 파사드.
 *
 * MVP raw-only 결정(2026-07-15): match-v5 원본을 match_v5_raw에만 저장한다.
 * 정규화(custom_match/match_participant/mmr_metric/match_ban) 적재는 하지 않는다 —
 * 코드 경기는 MVP 동안 전적·통계에 잡히지 않으며, 필요한 지표는 추후 raw에서
 * backfill로 정규화 테이블에 승격한다. (구 병행 적재 구현은 git 이력 참조)
 *
 * ⚠️ 상태 전이(markCompleted)가 적재와 같은 트랜잭션 안에 있으므로, 적재 실패 시 코드는
 * PENDING으로 롤백되어 폴백 폴링이 다시 회수한다(COMPLETED 유실 차단 — 기존 요건 유지).
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

    // 타임라인 원본도 확보한다(읽기 — 트랜잭션 밖). 실패해도 적재는 막지 않는다.
    // match_v5_raw.timeline_json NULL로 남고 추후 backfill 가능.
    let timeline: MatchTimelineDto | null = null;
    try {
      timeline = await getMatchTimeline(matchId);
    } catch (error) {
      console.warn(`[tournamentSave] timeline 조회 실패(원본은 NULL로 적재) matchId=${matchId}`, error);
    }

    const loaded = await this.loadMatch(matchV5, timeline, code);

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
   * @desc 검증된 match-v5 원본을 단일 트랜잭션으로 match_v5_raw에 저장한다.
   * @returns loaded=true 신규 적재 / false 이미 적재된 경기(멱등 skip).
   */
  private async loadMatch(
    matchV5: MatchV5Dto,
    timeline: MatchTimelineDto | null,
    code: TournamentCode,
  ): Promise<boolean> {
    const matchId = matchV5.metadata.matchId;
    const guildId = code.guildId;

    return db.transaction(async (tx: TransactionType) => {
      // 0. 멱등 방어: 같은 matchId가 이미 적재됐으면 재적재하지 않는다.
      //    코드가 아직 PENDING이면(콜백/폴링 중복 등) COMPLETED로만 맞춰준다.
      const existing = await tx
        .select({ id: matchV5Raw.id })
        .from(matchV5Raw)
        .where(eq(matchV5Raw.matchId, matchId))
        .limit(1);

      if (existing.length > 0) {
        await tournamentService.markCompleted(code.code, matchId, tx);
        return false;
      }

      // 1. 길드 확인 — 코드 발급 시 이미 존재하는 길드. 없으면 적재 중단(오염 방지).
      const foundGuild = await guildService.findGuildById(guildId, tx);
      if (!foundGuild) {
        throw new SystemError(`Guild not found for tournament code load: ${guildId}`, 500);
      }

      // 2. match_v5_raw — match-v5 원본 전체 + timeline 보존 (raw-only 저장의 전부).
      await tx.insert(matchV5Raw).values({
        matchId,
        guildId,
        matchJson: matchV5,
        timelineJson: timeline,
      });

      // 3. tournament_code COMPLETED 전이 + matchId·used_date 기록 (같은 트랜잭션).
      await tournamentService.markCompleted(code.code, matchId, tx);

      return true;
    });
  }
}

export const tournamentSaveFacade = new TournamentSaveFacade();
