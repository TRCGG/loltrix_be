// 토너먼트코드(TRC-225) API·콜백 타입.

/** POST /tournament/codes 요청 바디 (봇이 발급 요청 시 보냄). */
export interface IssueCodesRequest {
  guildId: string;
  /** 코드를 게시할 디스코드 채널 id. metadata에 저장되어 콜백 시 다음 코드 게시 대상이 된다. */
  channelId: string;
  /** 선발급 개수. */
  count: number;
}

/** tournament_code.metadata(jsonb)에 저장하는 자체 메타. */
export interface TournamentCodeMetadata {
  guildId: string;
  channelId: string;
}

/** 발급된 코드 1건(응답용). */
export interface IssuedCode {
  code: string;
  guildId: string;
  channelId: string | null;
  status: string;
  issuedDate: Date;
}

/**
 * Riot 토너먼트 콜백 페이로드(최소).
 * ⚠️ 신뢰하지 않는다 — shortCode/gameId만 참고해 match-v5로 재검증한다(§보안 불변식).
 */
export interface RiotTournamentCallbackPayload {
  shortCode?: string;
  gameId?: number;
  region?: string;
  metaData?: string;
  [key: string]: unknown;
}
