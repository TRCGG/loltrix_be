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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @desc Riot API 전용 fetch.
 * - X-Riot-Token 헤더로 인증한다.
 * - 429면 Retry-After만큼 대기 후 재시도(최대 2회). 그 외 4xx/5xx는 SystemError로 던진다.
 * - 타임아웃 초과 시 abort → 504 SystemError.
 */
export async function riotRequest<T>(
  fullUrl: string,
  apiKey: string,
  options: RiotRequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = options;
  const hasBody = body !== undefined;

  let attempt = 0;

  // 429 재시도 루프. 그 외 응답은 루프 안에서 즉시 반환/throw 한다.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

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
        throw new SystemError(`Riot API 요청이 ${timeout}ms 후 타임아웃되었습니다. (${fullUrl})`, 504);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    // rate limit: Retry-After(초) 만큼 대기 후 재시도.
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRY) {
      const retryAfterSec = Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_AFTER_SEC;
      attempt += 1;
      await sleep(retryAfterSec * 1000);
      continue;
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new SystemError(
        `Riot API 요청 실패 (upstream ${response.status}): ${method} ${fullUrl} ${errorBody}`.trim(),
        502,
      );
    }

    // 204 No Content 등 빈 바디 대응.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
