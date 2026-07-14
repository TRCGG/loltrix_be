import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { db, TransactionType } from '../database/connectionPool.js';
import { tournament, tournamentCode, tournamentProvider, TournamentCode } from '../database/schema.js';
import {
  registerProvider,
  registerTournament,
  createTournamentCodes,
  TournamentCodeParams,
} from '../clients/riot/index.js';
import { SystemError } from '../types/error.js';
import { GameType, IssuedCode, IssueSource, TournamentCodeMetadata } from '../types/tournament.js';

// 코드 발급 기본 파라미터(기획 문서 §발급). 5v5 토너먼트 드래프트, 소환사의 협곡, 전체 관전.
const DEFAULT_CODE_PARAMS = {
  mapType: 'SUMMONERS_RIFT',
  pickType: 'TOURNAMENT_DRAFT',
  spectatorType: 'ALL',
  teamSize: 5,
} as const;

/**
 * @desc 토너먼트코드 발급 체인 서비스.
 * provider/tournament 등록(멱등)과 코드 선발급을 담당한다.
 * dev 키는 24h 만료 → 재등록이 필요하므로 등록은 멱등하게(활성 행 재사용, 강제 재등록 옵션) 다룬다.
 */
export class TournamentService {
  /** provider 등록 region (플랫폼). 예: KR */
  private get region(): string {
    return process.env.RIOT_TOURNAMENT_REGION || 'KR';
  }

  /** tournament 등록 이름. */
  private get tournamentName(): string {
    return process.env.RIOT_TOURNAMENT_NAME || 'trcgg-mvp';
  }

  /** provider 등록 시 Riot에 전달할 콜백 URL. 등록 시에만 필요. */
  private get callbackUrl(): string {
    const url = process.env.RIOT_CALLBACK_URL;
    if (!url) {
      throw new SystemError(
        'RIOT_CALLBACK_URL 환경변수가 설정되지 않았습니다. provider 등록에 필요합니다.',
        500,
      );
    }
    return url;
  }

  /**
   * @desc provider/tournament를 확보한다. Riot tournament id를 반환.
   * - 기본(멱등): 활성(is_deleted=false) tournament 행이 있으면 그 Riot id를 재사용한다.
   * - forceReregister=true: 기존 활성 행을 soft-delete 후 Riot에 새로 등록한다(dev 키 24h 만료 재발급 대응).
   */
  public async ensureProviderAndTournament(
    opts: { forceReregister?: boolean } = {},
  ): Promise<{ providerId: number; tournamentId: number }> {
    if (!opts.forceReregister) {
      const existing = await db
        .select()
        .from(tournament)
        .where(eq(tournament.isDeleted, false))
        .orderBy(desc(tournament.id))
        .limit(1);

      if (existing.length > 0) {
        return { providerId: existing[0].providerId, tournamentId: existing[0].tournamentId };
      }
    } else {
      // 강제 재등록: 기존 활성 행 soft-delete (이력 보존).
      await db
        .update(tournament)
        .set({ isDeleted: true })
        .where(eq(tournament.isDeleted, false));
      await db
        .update(tournamentProvider)
        .set({ isDeleted: true })
        .where(eq(tournamentProvider.isDeleted, false));
    }

    const region = this.region;
    const callbackUrl = this.callbackUrl;

    // 1. Riot provider 등록 → provider id.
    const providerId = await registerProvider({ region, url: callbackUrl });
    await db.insert(tournamentProvider).values({ providerId, region, callbackUrl });

    // 2. Riot tournament 등록 → tournament id.
    const tournamentId = await registerTournament({ name: this.tournamentName, providerId });
    await db.insert(tournament).values({ tournamentId, providerId, name: this.tournamentName });

    return { providerId, tournamentId };
  }

  /**
   * @desc count개 코드를 선발급하고 tournament_code 행으로 저장한다(status PENDING).
   * channelId는 봇 발급 시에만 metadata(jsonb)에 저장 — 콜백 수신 시 그 채널로 다음 코드를
   * 게시하기 위함. 웹 발급(source=WEB)은 채널이 없고 issuedBy로 발급자를 남긴다.
   * gameType(1=일반내전/2=스크림/3=대회)은 발급 시 확정되어 적재 시 custom_match로 전파된다.
   */
  public async issueCodes(params: {
    guildId: string;
    channelId?: string;
    count: number;
    source: IssueSource;
    issuedBy?: string;
    gameType?: GameType;
  }): Promise<IssuedCode[]> {
    const { guildId, channelId, count, source, issuedBy, gameType = '1' } = params;

    const { tournamentId } = await this.ensureProviderAndTournament();

    const metadata: TournamentCodeMetadata = {
      guildId,
      source,
      ...(channelId ? { channelId } : {}),
      ...(issuedBy ? { issuedBy } : {}),
    };

    // Riot 코드 임베드 metadata는 문자열. 콜백에서 반환되나 신뢰하지 않으므로 참고용.
    const codeParams: TournamentCodeParams = {
      ...DEFAULT_CODE_PARAMS,
      count,
      metadata: JSON.stringify(metadata),
    };

    const codes = await createTournamentCodes(tournamentId, codeParams);

    if (!codes || codes.length === 0) {
      throw new SystemError('Riot가 발급한 코드가 없습니다.', 502);
    }

    const rows = codes.map((code) => ({
      code,
      tournamentId,
      guildId,
      gameType,
      metadata,
      status: 'PENDING',
    }));

    const inserted = await db.insert(tournamentCode).values(rows).returning();

    return inserted.map(this.toIssuedCode);
  }

  /**
   * @desc 길드의 미사용(PENDING) 다음 코드 1건 — issued_date 오름차순 첫 코드. 봇 !다음코드 용.
   */
  public async getNextCode(guildId: string): Promise<IssuedCode | null> {
    const rows = await db
      .select()
      .from(tournamentCode)
      .where(
        and(
          eq(tournamentCode.guildId, guildId),
          eq(tournamentCode.status, 'PENDING'),
          eq(tournamentCode.isDeleted, false),
        ),
      )
      .orderBy(asc(tournamentCode.issuedDate))
      .limit(1);

    return rows.length > 0 ? this.toIssuedCode(rows[0]) : null;
  }

  /**
   * @desc code가 PENDING 상태로 DB에 존재하는지 조회한다(콜백 재검증 1단계). 없으면 null.
   */
  public async findPendingByCode(code: string): Promise<TournamentCode | null> {
    const rows = await db
      .select()
      .from(tournamentCode)
      .where(
        and(
          eq(tournamentCode.code, code),
          eq(tournamentCode.status, 'PENDING'),
          eq(tournamentCode.isDeleted, false),
        ),
      )
      .limit(1);

    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * @desc 검증 통과한 코드를 COMPLETED로 전이하고 used_date를 갱신한다.
   * custom_match_id는 적재(단계 5)에서 채워진다.
   * ⚠️ tx를 넘기면 적재 트랜잭션 안에서 전이한다(적재 실패 시 PENDING 유지 — 계획서 단계4 ⚠️ 요건).
   */
  public async markCompleted(
    code: string,
    customMatchId?: string,
    tx?: TransactionType,
  ): Promise<void> {
    const runner = tx ?? db;
    await runner
      .update(tournamentCode)
      .set({
        status: 'COMPLETED',
        usedDate: new Date(),
        ...(customMatchId ? { customMatchId } : {}),
      })
      .where(eq(tournamentCode.code, code));
  }

  /**
   * @desc 발급 후 오래 지난 PENDING 코드를 INVALID로 만료 전이한다.
   * 게임 없이 버려진 코드(여분 발급 등)가 폴링 대상으로 영구히 남아
   * 매 주기 games/by-code를 소모하는 것을 차단한다. 경기는 보통 발급 후
   * 1~2시간 내 진행되므로 기본 3시간이면 안전 마진 충분(확정 결정 2026-07-14).
   * 기준 시간은 system_config TOURNAMENT_CODE_EXPIRE_HOURS로 무중단 조정 가능.
   * @returns 전이된 코드 수
   */
  public async expireStalePendingCodes(olderThan: Date): Promise<number> {
    const rows = await db
      .update(tournamentCode)
      .set({ status: 'INVALID' })
      .where(
        and(
          eq(tournamentCode.status, 'PENDING'),
          eq(tournamentCode.isDeleted, false),
          lte(tournamentCode.issuedDate, olderThan),
        ),
      )
      .returning({ code: tournamentCode.code });
    return rows.length;
  }

  /**
   * @desc 폴백 폴링 대상: PENDING이고 issued_date가 기준시각(olderThan) 이전인 코드들.
   * 콜백 유실/stub 무콜백을 games/by-code로 회수하기 위한 조회.
   */
  public async findDuePendingCodes(olderThan: Date): Promise<TournamentCode[]> {
    return db
      .select()
      .from(tournamentCode)
      .where(
        and(
          eq(tournamentCode.status, 'PENDING'),
          eq(tournamentCode.isDeleted, false),
          lte(tournamentCode.issuedDate, olderThan),
        ),
      )
      .orderBy(asc(tournamentCode.issuedDate));
  }

  /** DB 행 → 응답 DTO. metadata(jsonb)에서 channelId·source를 꺼낸다(source 미존재=BOT, 과거 행). */
  private toIssuedCode(row: TournamentCode): IssuedCode {
    const meta = (row.metadata ?? null) as TournamentCodeMetadata | null;
    return {
      code: row.code,
      guildId: row.guildId,
      channelId: meta?.channelId ?? null,
      source: meta?.source ?? 'BOT',
      gameType: row.gameType,
      status: row.status,
      issuedDate: row.issuedDate,
    };
  }
}

export const tournamentService = new TournamentService();
