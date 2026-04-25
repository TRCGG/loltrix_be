// discordAuth.controller.ts
import { Request, Response, NextFunction } from 'express';
import { DiscordAuthService } from '../services/discordAuth.service.js';
import { BusinessError, SystemError } from '../types/error.js';
import { AuthRequest } from '../middlewares/authHandler.js';
import { DiscordMemberGuildService } from '../services/discordMemberGuild.service.js';
import { discordMemberRoleService } from '../services/discordMemberRole.service.js';
import { DiscordGuildAPI, DiscordGuildAPIResponse } from '../types/discordAuth.js';
import { systemConfigService } from '../services/systemConfig.service.js';
import { getCookieOptions } from '../utils/cookieOptions.js';
import { ADMIN_ROLES, Role } from '../types/role.js';

const discordAuthService = new DiscordAuthService();
const discordMemberGuildService = new DiscordMemberGuildService();

async function getFrontendUrl(): Promise<string> {
  const key = process.env.NODE_ENV === 'development' ? 'FRONTEND_URL_DEV' : 'FRONTEND_URL_PROD';
  const fallback = process.env.NODE_ENV === 'development' ? 'https://dev.gmok.kr' : 'https://gmok.kr';
  return systemConfigService.getConfigOrDefault(key, fallback);
}

/**
 * @route GET /api/auth/login
 * @desc 디스코드 로그인 시작 (디스코드로 리디렉션)
 * @access Public
 */
export const login = async (req: Request, res: Response<void>, next: NextFunction): Promise<void> => {
  try {
    const authorizeUrl = await discordAuthService.getDiscordAuthorizeUrl();
    res.redirect(authorizeUrl);
  } catch (error) {
    next();
  }
};

/**
 * @route GET /api/auth/callback/:code
 * @desc 디스코드 로그인 콜백 처리
 * @access Public
 */
export const callback = async (
  req: Request<Record<string, never>, void, never, { code?: string; error?: string }>,
  res: Response<void>,
  next: NextFunction,
) => {
  const { code, error } = req.query;

  if (error === 'access_denied') {
    const frontendUrl = await getFrontendUrl();
    return res.redirect(frontendUrl);
  }

  if (!code) {
    return next(new BusinessError('Authorization code missing'));
  }

  try {
    const sessionUid = await discordAuthService.handleDiscordCallback(
      code,
      req.headers['user-agent'],
      (req.ip || req.connection.remoteAddress) as string,
    );

    const [frontendUrl, cookieOptions] = await Promise.all([getFrontendUrl(), getCookieOptions()]);
    res.cookie('session_uid', sessionUid, cookieOptions);
    return res.redirect(frontendUrl);
  } catch (err) {
    return next(err);
  }
};

/**
 * @route POST /api/auth/logout
 * @desc  로그아웃 (디스코드 토큰 폐기)
 * @access Public
 */
export const logout = async (req: Request, res: Response<void>) => {
  try {
    const sessionUid = req.cookies.session_uid;
    const [frontendUrl, cookieOptions] = await Promise.all([getFrontendUrl(), getCookieOptions()]);
    res.clearCookie('session_uid', cookieOptions);

    if (sessionUid) {
      await discordAuthService.revokeAndDeactivateSession(sessionUid);
    }

    return res.redirect(frontendUrl);
  } catch (error) {
    console.error('error during logout process', error);
    const [frontendUrl, cookieOptions] = await Promise.all([getFrontendUrl(), getCookieOptions()]);
    res.clearCookie('session_uid', cookieOptions);
    return res.redirect(frontendUrl);
  }
};

/**
 * @route GET /api/auth/guilds
 * @desc (Protected) 현재 인증된 유저의 gmok이 있는 길드 목록 가져오기
 * @access Private (auth.middleware를 통과해야 함)
 */
export const getGmokGuilds = async (req: AuthRequest, res: Response<DiscordGuildAPIResponse>) => {
  try {
    // 1. 유저 요청 처리
    const { accessToken, discordMemberId } = req;

    if (!accessToken || !discordMemberId) {
      throw new SystemError('Access token not found after auth middleware');
    }

    // 2. 활성 권한 조회 후 guilds 조회
    const activeRoles = await discordMemberRoleService.getActiveRoles(discordMemberId);
    const isAdmin = activeRoles.some((r) => ADMIN_ROLES.includes(r.role as Role));
    let guildsData: DiscordGuildAPI[];

    if (isAdmin) {
      guildsData = await discordMemberGuildService.findAdminGmokGuilds(activeRoles);
    } else {
      const joinedGmokGuilds = await discordMemberGuildService.findJoinedGmokGuilds(accessToken);
      const ensuredRoles = await discordMemberRoleService.ensureDefaultRolesForGuilds(
        discordMemberId,
        joinedGmokGuilds.map((g) => g.id),
        activeRoles,
      );
      guildsData = discordMemberGuildService.applyRolesToGuilds(joinedGmokGuilds, ensuredRoles);
    }
    res.status(200).json({
      status: 'success',
      message: 'gmok Guilds find successfully',
      data: guildsData,
    });
  } catch (error) {
    console.error('getSelfGuilds error', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error discordAuth getGmokGuilds',
      data: null,
    });
  }
};

/**
 * @route GET /api/auth/me
 * @desc [(Protected) 현재 세션의 유저 ID 조회 (세션 체크용)
 * @access Private
 */
export const getSelfProfile = async (req: AuthRequest, res: Response) => {
  try {
    const { accessToken } = req;

    if (!accessToken) {
      throw new SystemError('Access token not found after auth middleware');
    }

    if (!req.discordMemberId) {
      res.status(500).json({
        status: 'error',
        message: 'User ID not found after auth middleware',
        data: null,
      });
    }

    const result = await discordAuthService.fetchUser(accessToken);

    res.status(200).json({
      status: 'success',
      message: 'session OK',
      data: {
        user: result,
      },
    });
  } catch (error) {
    console.error('getSelfProfile error');
    res.status(500).json({
      status: 'error',
      message: 'Internal server error while discordAuth getSelfProfile',
      data: null,
    });
  }
};
