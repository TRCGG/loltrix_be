import { getRiotConfig } from './riotConfig.js';
import { riotRequest } from './riotHttp.js';
import {
  ProviderRegistrationParams,
  TournamentCodeParams,
  TournamentGamesDto,
  TournamentRegistrationParams,
} from './types.js';

/**
 * @desc provider 등록. provider id(number)를 반환한다.
 * dev 키는 24h 만료 → 재등록이 필요하므로 등록 스크립트를 멱등하게 다룰 것.
 */
export async function registerProvider(params: ProviderRegistrationParams): Promise<number> {
  const cfg = getRiotConfig();
  return riotRequest<number>(`${cfg.tournamentBaseUrl}/providers`, cfg.apiKey, {
    method: 'POST',
    body: params,
  });
}

/**
 * @desc tournament 등록. tournament id(number)를 반환한다.
 */
export async function registerTournament(params: TournamentRegistrationParams): Promise<number> {
  const cfg = getRiotConfig();
  return riotRequest<number>(`${cfg.tournamentBaseUrl}/tournaments`, cfg.apiKey, {
    method: 'POST',
    body: params,
  });
}

/**
 * @desc 토너먼트 코드 발급. count개 선발급하고 코드 문자열 배열을 반환한다.
 * count는 query, 나머지 파라미터는 body로 보낸다.
 */
export async function createTournamentCodes(
  tournamentId: number,
  params: TournamentCodeParams,
): Promise<string[]> {
  const cfg = getRiotConfig();
  const { count = 1, ...body } = params;
  const query = new URLSearchParams({
    count: String(count),
    tournamentId: String(tournamentId),
  }).toString();
  return riotRequest<string[]>(`${cfg.tournamentBaseUrl}/codes?${query}`, cfg.apiKey, {
    method: 'POST',
    body,
  });
}

/**
 * @desc 코드로 경기 목록을 조회한다(폴백 폴링용).
 * 콜백이 유실됐거나 stub처럼 콜백이 안 오는 경우 PENDING 코드를 이 API로 회수한다.
 */
export async function getGamesByCode(tournamentCode: string): Promise<TournamentGamesDto[]> {
  const cfg = getRiotConfig();
  return riotRequest<TournamentGamesDto[]>(
    `${cfg.tournamentBaseUrl}/games/by-code/${encodeURIComponent(tournamentCode)}`,
    cfg.apiKey,
  );
}
