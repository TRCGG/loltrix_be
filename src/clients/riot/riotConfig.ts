import { SystemError } from '../../types/error.js';

/**
 * @desc Riot API 클라이언트 설정 (env 기반).
 * - API 키는 RIOT_API_KEY env로만 관리한다. 어떤 파일에도 하드코딩하지 않는다.
 * - RIOT_TOURNAMENT_STUB=true면 tournament-stub-v5, false면 tournament-v5 경로를 쓴다.
 * - 리전 라우팅: tournament v5는 americas 고정, match-v5는 KR 기준 asia.
 */
export interface RiotClientConfig {
  apiKey: string;
  useStub: boolean;
  /** 예: https://americas.api.riotgames.com/lol/tournament-stub/v5 */
  tournamentBaseUrl: string;
  /** 예: https://asia.api.riotgames.com/lol/match/v5 */
  matchBaseUrl: string;
}

// tournament v5는 americas 리저널 라우팅 고정.
const DEFAULT_TOURNAMENT_HOST = 'americas.api.riotgames.com';
// match-v5는 리저널 라우팅. KR 플랫폼 → asia 리전.
const DEFAULT_MATCH_HOST = 'asia.api.riotgames.com';

let cached: RiotClientConfig | null = null;

/**
 * @desc env로부터 Riot 클라이언트 설정을 만든다(성공 시 캐시).
 * RIOT_API_KEY 미설정이면 SystemError를 던진다.
 */
export function getRiotConfig(): RiotClientConfig {
  if (cached) return cached;

  const apiKey = process.env.RIOT_API_KEY;
  if (!apiKey) {
    throw new SystemError('RIOT_API_KEY 환경변수가 설정되지 않았습니다.', 500);
  }

  const useStub = process.env.RIOT_TOURNAMENT_STUB === 'true';
  const tournamentSegment = useStub ? 'tournament-stub' : 'tournament';
  const tournamentHost = process.env.RIOT_TOURNAMENT_HOST || DEFAULT_TOURNAMENT_HOST;
  const matchHost = process.env.RIOT_MATCH_HOST || DEFAULT_MATCH_HOST;

  cached = {
    apiKey,
    useStub,
    tournamentBaseUrl: `https://${tournamentHost}/lol/${tournamentSegment}/v5`,
    matchBaseUrl: `https://${matchHost}/lol/match/v5`,
  };

  return cached;
}

/**
 * @desc 캐시 무효화. dev 키 재등록·테스트에서 env가 바뀐 뒤 재로딩할 때 사용.
 */
export function resetRiotConfigCache(): void {
  cached = null;
}
