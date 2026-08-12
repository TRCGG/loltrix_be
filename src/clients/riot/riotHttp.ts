import { SystemError } from '../../types/error.js';

// riot 전용 http 유틸. Discord 전용 fetchWithTimeout.ts는 재사용하지 않되
// 타임아웃·abort 패턴은 그대로 참고한다.
const DEFAULT_TIMEOUT = 10000;
// 429(rate limit) 시 재시도 최대 횟수.
const MAX_RATE_LIMIT_RETRY = 2;
// Retry-After 헤더가 없을 때의 기본 대기(초).
const DEFAULT_RETRY_AFTER_SEC = 1;

export interface RiotRequestOptions {
  method?: string;
  /** JSON 직렬화되어 전송된다. */
  body?: unknown;
  /** 밀리초 타임아웃(기본 10000). */
  timeout?: number;
  /**
   * 집계용 경로. 실제 id가 아니라 `/matches/{matchId}` 형태의 템플릿을 넘긴다.
   * id가 그대로 들어오면 호출 1건마다 값이 달라져 route별 집계가 불가능해진다.
   */
  route: string;
  /** 호출 주체. 콜백·폴링처럼 진입점이 갈리는 곳은 진입점 단위로 넘긴다. */
  caller: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RiotCallEvent {
  route: string;
  caller: string;
  status: number;
  durationMs: number;
  rateLimitCount: string | null;
}

/**
 * @desc Riot 호출 1건을 stdout에 한 줄로 남긴다(집계용).
 * status 0은 HTTP 응답을 받지 못한 경우(타임아웃·네트워크 실패)를 뜻한다.
 */
function logRiotCall(event: RiotCallEvent): void {
  console.log(
    JSON.stringify({
      event: 'riot.call',
      route: event.route,
      caller: event.caller,
      status: event.status,
      duration_ms: event.durationMs,
      rate_limit_count: event.rateLimitCount,
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * @desc Riot API 전용 fetch.
 * - X-Riot-Token 헤더로 인증한다.
 * - 429면 Retry-After만큼 대기 후 재시도(최대 2회). 그 외 4xx/5xx는 SystemError로 던진다.
 * - 타임아웃 초과 시 abort → 504 SystemError.
 * - HTTP 시도마다 riot.call 이벤트를 남긴다. 재시도도 쿼터를 차감하므로 호출량 집계의
 *   단위는 riotRequest 호출이 아니라 시도다.
 */
export async function riotRequest<T>(
  fullUrl: string,
  apiKey: string,
  options: RiotRequestOptions,
): Promise<T> {
  const { method = 'GET', body, timeout = DEFAULT_TIMEOUT, route, caller } = options;
  const hasBody = body !== undefined;

  let attempt = 0;

  // 429 재시도 루프. 그 외 응답은 루프 안에서 즉시 반환/throw 한다.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const startedAt = Date.now();
    let status = 0;
    let durationMs: number | null = null;
    let rateLimitCount: string | null = null;
    let retryDelayMs: number | null = null;

    try {
      let response: Response;
      try {
        response = await fetch(fullUrl, {
          method,
          headers: {
            'X-Riot-Token': apiKey,
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          },
          body: hasBody ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          throw new SystemError(
            `Riot API 요청이 ${timeout}ms 후 타임아웃되었습니다. (${fullUrl})`,
            504,
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      // 응답 헤더 수신까지만 잰다. 바디 읽기·파싱을 포함하면 응답이 큰 route(timeline은 수 MB)만
      // 체계적으로 부풀려져 route 간 지연 비교가 어긋난다.
      durationMs = Date.now() - startedAt;
      status = response.status;
      // Riot은 남은 횟수를 주지 않고 사용량("20:10,100:600")만 준다. 가공 없이 그대로 남긴다.
      rateLimitCount = response.headers.get('X-App-Rate-Limit-Count');

      // rate limit: Retry-After(초) 만큼 대기 후 재시도.
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRY) {
        const retryAfterSec =
          Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_AFTER_SEC;
        attempt += 1;
        retryDelayMs = retryAfterSec * 1000;
      } else if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new SystemError(
          `Riot API 요청 실패 (upstream ${response.status}): ${method} ${fullUrl} ${errorBody}`.trim(),
          502,
        );
      } else {
        // 204 No Content 등 빈 바디 대응.
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
    } finally {
      logRiotCall({
        route,
        caller,
        status,
        durationMs: durationMs ?? Date.now() - startedAt,
        rateLimitCount,
      });
    }

    // 재시도 대기는 finally 바깥에 둔다 — 안에 두면 duration_ms에 대기 시간이 섞인다.
    if (retryDelayMs !== null) {
      await sleep(retryDelayMs);
    }
  }
}
