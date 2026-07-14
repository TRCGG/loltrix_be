import { tournamentService } from './tournament.service.js';

/**
 * @desc 적재 성공 후 봇에게 "이 채널에 다음 코드를 게시하라"고 지시하는 fire-and-forget 통지 (TRC-226 단계 3).
 *
 * ⚠️ 불변식: 이 서비스는 **절대 throw하지 않는다**. 어떤 실패도 로그만 남기고 흡수한다.
 * 통지가 콜백 응답(200 ack)이나 폴링 루프를 깨면 안 되기 때문 — 호출부는 await하되 예외가 전파되지 않는다.
 *
 * 통신: POST {BOT_CALLBACK_URL}/post-next-code
 *  - 헤더 x-discord-bot: DISCORD_BOT_SECRET (봇→백엔드와 동일 시크릿 역방향 재사용)
 *  - 바디 { channelId, code }
 */
const DEFAULT_BOT_CALLBACK_URL = 'http://127.0.0.1:19902';
const NOTIFY_TIMEOUT_MS = 5000;

export class BotNotifyService {
  private get callbackBaseUrl(): string {
    return process.env.BOT_CALLBACK_URL || DEFAULT_BOT_CALLBACK_URL;
  }

  /**
   * @desc guild의 다음 PENDING 코드를 조회해 봇의 /post-next-code로 게시 지시한다.
   * 다음 코드가 없으면 아무것도 하지 않는다.
   * @param guildId 길드 id
   * @param channelId 게시 대상 채널 id (방금 적재된 코드의 metadata에서 추출)
   */
  public async notifyNextCode(guildId: string, channelId: string): Promise<void> {
    try {
      const next = await tournamentService.getNextCode(guildId);
      if (!next) return; // 남은 코드 없음 — 통지 불필요.

      const secret = process.env.DISCORD_BOT_SECRET;
      if (!secret) {
        console.warn('[botNotify] DISCORD_BOT_SECRET 미설정 — 봇 통지를 생략합니다.');
        return;
      }

      const url = `${this.callbackBaseUrl}/post-next-code`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-discord-bot': secret,
          },
          body: JSON.stringify({ channelId, code: next.code }),
          signal: controller.signal,
        });

        if (!response.ok) {
          console.warn(`[botNotify] 봇 통지 실패 status=${response.status} url=${url}`);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      // fire-and-forget: 어떤 실패(네트워크·타임아웃·봇 다운 등)도 상위로 전파하지 않는다.
      console.error('[botNotify] 다음 코드 통지 중 오류(무시):', error);
    }
  }
}

export const botNotifyService = new BotNotifyService();
