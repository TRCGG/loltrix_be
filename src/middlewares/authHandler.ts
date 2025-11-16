import { Request, Response, NextFunction } from 'express';
import { DiscordAuthService } from '../services/discordAuth.service.js';
import { BusinessError, SystemError } from '../types/error.js';

const discordAuthService = new DiscordAuthService();
const botSecret = process.env.DISCORD_BOT_SECRET;

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
}

/**
 * @desc 인증 미들웨어 (봇/유저 통합)
 * 1. 봇 헤더 검증
 * 2. 세션 쿠키 검증
 * 3. 서비스 레이어를 통해 토큰 검증 및 자동 재발급
 * 4. req 객체에 discordMemberId, accessToken 주입
 */
export const verifyAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {

    // --- 봇 검증 --- 
    const botHeader = req.headers['discord-bot-header'];
    if (botHeader) {
      if(botHeader !== botSecret){
        throw new BusinessError('Invalid bot secret', 403, {isLoggable: false});
      }
      return next();
    }

    // --- 1. 유저 세션 검증 ---
    const sessionUid = req.cookies.session_uid;
    if (!sessionUid) {
      throw new BusinessError('Session cookie not found', 401, {isLoggable: false});
    }

    // 1a. 세션 조회 (DB)
    const authSession =
      await discordAuthService.findAuthSessionByUid(sessionUid);
    if (!authSession) {
      throw new BusinessError('Invalid or inactive session', 401, {isLoggable: false});
    }

    // 1b. 서비스 레이어에 토큰 검증 및 자동 재발급 위임
    const { discordMemberId } = authSession;
    const validAccessToken =
      await discordAuthService.getValidAccessToken(discordMemberId);

    // 2. (성공) req 객체에 인증 정보 주입
    req.discordMemberId = discordMemberId;
    req.accessToken = validAccessToken;
    
    next(); 
    
  } catch (error) {
    if (error instanceof BusinessError && error.status === 401) {
      res.clearCookie('session_uid', cookieOptions);
    }
    next(error);
  }
};