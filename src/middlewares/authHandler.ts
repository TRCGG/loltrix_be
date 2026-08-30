import { Request, Response, NextFunction } from 'express';
import { DiscordAuthService } from '../services/discordAuth.service.js';
import { BusinessError } from '../types/error.js';
import { getClearCookieOptions } from '../utils/cookieOptions.js';

const discordAuthService = new DiscordAuthService();
const LOCALHOST_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthRequest extends Request {
  discordMemberId?: string;
  accessToken?: string;
  isBot?: boolean;
}

/**
 * @desc 봇 접근 제한 (Localhost Only)
 * 봇과 서버가 같은 호스트에 있으므로, 봇 헤더가 붙은 요청은 로컬 연결에서만 허용한다.
 * 판정 기준은 요청에 붙은 쿠키가 아니라 봇 헤더 — 쿠키는 외부에서 임의로 붙일 수 있어
 * 쿠키로 검사를 건너뛰면 헤더만 얹어 봇 권한을 얻을 수 있다.
 * 주소는 req.ip가 아니라 소켓 주소로 본다 — trust proxy 미설정 상태에서 req.ip는
 * 프록시 주소이고, 홉 수를 알 수 없어 trust proxy를 켤 수도 없다.
 * 헤더가 없는 요청은 여기서 통과시키고 verifyAuth의 세션 검증에 맡긴다.
 */
export const restrictBotToLocalhost = (req: Request, res: Response, next: NextFunction) => {
  if (!req.headers['x-discord-bot']) {
    return next();
  }

  const remoteAddress = req.socket?.remoteAddress || '';

  if (!LOCALHOST_IPS.includes(remoteAddress)) {
    console.warn(`[auth] external bot request blocked: ${remoteAddress || 'unknown'}`);
    throw new BusinessError(`Access denied: External access not allowed (${remoteAddress})`, 403, {
      isLoggable: false,
    });
  }

  return next();
};

/**
 * @desc 인증 미들웨어 (봇/유저 통합)
 */
export const verifyAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // --- 봇 검증 ---
    const botHeader = req.headers['x-discord-bot'];
    if (botHeader) {
      // 모듈 로드 시점에 캡처하면 dotenv 로드 순서에 따라 undefined가 박힌다.
      const botSecret = process.env.DISCORD_BOT_SECRET;
      if (!botSecret || botHeader !== botSecret) {
        throw new BusinessError('Invalid bot secret', 403, { isLoggable: true });
      }
      req.isBot = true;
      return next();
    }

    // --- 1. 유저 세션 검증 ---
    const sessionUid = req.cookies.session_uid;
    if (!sessionUid) {
      throw new BusinessError('Session cookie not found', 401, { isLoggable: false });
    }

    // session_uid는 uuid 컬럼이라 형식이 어긋난 값을 그대로 조회하면 DB가 22P02를 던져 500이 된다.
    if (!UUID_PATTERN.test(sessionUid)) {
      throw new BusinessError('Malformed session cookie', 401, { isLoggable: false });
    }

    // 1a. 세션 조회 (DB)
    const authSession = await discordAuthService.findAuthSessionByUid(sessionUid);
    if (!authSession) {
      throw new BusinessError(`Invalid session attempt: ${sessionUid.substring(0, 8)}...`, 401, {
        isLoggable: true,
      });
    }

    // 1b. 서비스 레이어에 토큰 검증 및 자동 재발급 위임
    const { discordMemberId } = authSession;
    const validAccessToken = await discordAuthService.getValidAccessToken(discordMemberId);

    // 2. (성공) req 객체에 인증 정보 주입
    req.discordMemberId = discordMemberId;
    req.accessToken = validAccessToken;

    return next();
  } catch (error) {
    if (error instanceof BusinessError && error.status === 401) {
      const cookieOptions = await getClearCookieOptions();
      res.clearCookie('session_uid', cookieOptions);
    }
    return next(error);
  }
};
