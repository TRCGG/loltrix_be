// 토너먼트코드(TRC-225) API·콜백 타입.

/** 발급 주체. BOT=디스코드 봇(localhost), WEB=웹 세션 유저(guildManager 이상). */
export type IssueSource = 'BOT' | 'WEB';

/** POST /tournament/codes 요청 바디 (봇/웹 공용). */
export interface IssueCodesRequest {
  guildId: string;
  /**
   * 코드를 게시할 디스코드 채널 id (봇 발급 시). metadata에 저장되어
   * 콜백 시 다음 코드 게시 대상이 된다. 웹 발급은 게시 채널이 없으므로 생략.
   */
  channelId?: string;
  /** 선발급 개수. */
  count: number;
}

/** tournament_code.metadata(jsonb)에 저장하는 자체 메타. */
export interface TournamentCodeMetadata {
  guildId: string;
  /** 봇 발급 시에만 존재. 없으면 적재 후 봇 다음코드 게시를 생략한다. */
  channelId?: string;
  /** 발급 주체 (2026-07-14 추가 — 웹 발급 확장). 과거 행은 미존재=BOT으로 간주. */
  source?: IssueSource;
  /** 웹 발급 시 세션 유저의 discordMemberId (감사 추적용). */
  issuedBy?: string;
}

/** 발급된 코드 1건(응답용). */
export interface IssuedCode {
  code: string;
  guildId: string;
  channelId: string | null;
  /** 발급 주체. 과거 행(메타에 source 없음)은 BOT. */
  source: IssueSource;
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
