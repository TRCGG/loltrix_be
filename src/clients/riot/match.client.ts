import { getRiotConfig } from './riotConfig.js';
import { riotRequest } from './riotHttp.js';
import { MatchTimelineDto, MatchV5Dto } from './types.js';

/**
 * @desc Match-V5 매치 조회. matchId 예: 'KR_1234567890'. 리저널(asia) 라우팅.
 * 콜백 재검증(§보안)에서 info.tournamentCode를 DB 코드와 대조하는 데 쓰인다.
 */
export async function getMatch(matchId: string): Promise<MatchV5Dto> {
  const cfg = getRiotConfig();
  return riotRequest<MatchV5Dto>(
    `${cfg.matchBaseUrl}/matches/${encodeURIComponent(matchId)}`,
    cfg.apiKey,
  );
}

/**
 * @desc Match-V5 타임라인 조회. matchId 예: 'KR_1234567890'.
 */
export async function getMatchTimeline(matchId: string): Promise<MatchTimelineDto> {
  const cfg = getRiotConfig();
  return riotRequest<MatchTimelineDto>(
    `${cfg.matchBaseUrl}/matches/${encodeURIComponent(matchId)}/timeline`,
    cfg.apiKey,
  );
}
