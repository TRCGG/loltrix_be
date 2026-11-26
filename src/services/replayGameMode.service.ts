import { getMatch } from '../clients/riot/index.js';
import { BusinessError, SystemError } from '../types/error.js';

// 업로드 응답을 오래 붙잡지 않도록 짧게 끊고, 429도 기다리지 않고 통과시킨다.
// riotRequest의 timeout은 응답 헤더까지만 걸리므로 본문 수신까지 race로 한 번 더 묶는다.
const MATCH_LOOKUP_TIMEOUT_MS = 3000;

// .rofl 안에는 게임 ID가 없고 파일명에만 있다. Match-V5가 asia 라우팅이라 KR만 조회한다.
const KR_REPLAY_FILE_NAME = /^KR-(\d+)/i;

export type MatchLookupResult =
  | 'matched'
  | 'not_matched'
  | 'not_found'
  | 'lookup_failed'
  | 'no_match_id';

export interface MatchLookup {
  result: MatchLookupResult;
  matchId: string | null;
  /** lookup_failed일 때 원인. riot_upstream_<status> | timeout | 에러 이름 */
  failure?: string;
}

export type GameModeCheckResult = 'aram' | MatchLookupResult;

const REJECTED_RESULTS: ReadonlySet<GameModeCheckResult> = new Set(['aram', 'matched']);

export function matchIdFromFileName(fileName: string): string | null {
  const matched = KR_REPLAY_FILE_NAME.exec(fileName);
  return matched ? `KR_${matched[1]}` : null;
}

// 협곡은 랭크·내전 모두 포지션 추론값이 채워지고, 칼바람은 전원 빈 값이다.
export function isAramStats(stats: unknown): boolean {
  return (
    Array.isArray(stats) &&
    stats.length > 0 &&
    stats.every((player) => !(player as { TEAM_POSITION?: unknown } | null)?.TEAM_POSITION)
  );
}

export function unsupportedGameModeError(): BusinessError {
  return new BusinessError(
    '사용자 설정 게임 리플만 등록할 수 있습니다. (칼바람·랭크 등 매칭 게임 불가)',
    400,
    { type: 'unsupported-game-mode', title: 'Unsupported Game Mode', isLoggable: false },
  );
}

const LOOKUP_TIMEOUT = Symbol('lookup-timeout');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(LOOKUP_TIMEOUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(error: unknown): string {
  if (error === LOOKUP_TIMEOUT) return 'timeout';
  if (error instanceof SystemError) return error.code ?? `status_${error.status}`;
  return error instanceof Error ? error.name : 'unknown';
}

function logGameModeCheck(
  caller: string,
  result: GameModeCheckResult,
  lookup: MatchLookup | null,
): void {
  console.log(
    JSON.stringify({
      event: 'replay.game_mode_check',
      caller,
      result,
      match_id: lookup?.matchId ?? null,
      failure: lookup?.failure ?? null,
      ts: new Date().toISOString(),
    }),
  );
}

export class ReplayGameModeService {
  /**
   * @desc 절대 reject하지 않는다 — 다운로드와 병렬로 띄워 두고 나중에 await하므로,
   * 다운로드가 먼저 실패해도 unhandled rejection이 나지 않아야 한다.
   * 로비 내전은 404, 일부 매칭 게임(칼바람 등)은 403이 오므로 조회 실패는 판단 불가로 둔다.
   */
  public async lookupMatch(fileName: string, caller: string): Promise<MatchLookup> {
    const matchId = matchIdFromFileName(fileName);
    if (!matchId) return { result: 'no_match_id', matchId };

    try {
      const match = await withTimeout(
        getMatch(matchId, caller, { timeout: MATCH_LOOKUP_TIMEOUT_MS, maxRateLimitRetry: 0 }),
        MATCH_LOOKUP_TIMEOUT_MS,
      );
      return {
        result: match.info?.gameType === 'MATCHED_GAME' ? 'matched' : 'not_matched',
        matchId,
      };
    } catch (error) {
      const failure = describeFailure(error);
      if (failure === 'riot_upstream_404') return { result: 'not_found', matchId };
      return { result: 'lookup_failed', matchId, failure };
    }
  }

  public async check(
    stats: unknown,
    lookup: () => Promise<MatchLookup>,
    caller: string,
  ): Promise<GameModeCheckResult> {
    if (isAramStats(stats)) {
      logGameModeCheck(caller, 'aram', null);
      return 'aram';
    }

    const matchLookup = await lookup();
    logGameModeCheck(caller, matchLookup.result, matchLookup);
    return matchLookup.result;
  }

  public isRejected(result: GameModeCheckResult): boolean {
    return REJECTED_RESULTS.has(result);
  }
}

export const replayGameModeService = new ReplayGameModeService();
