import { Request, Response, NextFunction } from 'express';
import { DiscordAuthService } from '../services/discordAuth.service.js';
import { BusinessError } from '../types/error.js';

const discordAuthService = new DiscordAuthService();
const botSecret = process.env.DISCORD_BOT_SECRET;
const LOCALHOST_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

const cookieOptions = {
  domain: '.gmok.kr',
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'none' as const,
};

export interface AuthRequest extends Request {
  discordMemberId?: string;
  accessToken?: string;
  isBot?: boolean;
}

/**
 * @desc 봇 접근 제한 (Localhost Only)
 * 봇과 서버가 같으므로, 외부 IP에서의 접근은 무조건 차단하고
 * 오직 내부(Localhost)에서 온 요청만 허용합니다.
 */
export const restrictBotToLocalhost = (req: Request, res: Response, next: NextFunction) => {
  // 1. 유저 세션이 있으면(브라우저 접근) IP 검사 스킵 -> 통과
  if (req.cookies?.session_uid) {
    return next();
  }

  // 2. 세션이 없다면 봇 요청으로 간주 -> IP 검사
  // req.ip가 로컬호스트 주소인지 확인
  const clientIp = req.ip || '';

  if (!LOCALHOST_IPS.includes(clientIp)) {
    // 외부에서 봇 API를 찌르려고 하면 차단
    throw new BusinessError(`Access denied: External access not allowed (${clientIp})`, 403, {
      isLoggable: true,
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
      if (botHeader !== botSecret) {
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
      res.clearCookie('session_uid', cookieOptions);
    }
    return next(error);
  }
};
