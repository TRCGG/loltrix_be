import { Response, NextFunction } from 'express';
import { Role, ADMIN_ROLES, hasMinRole } from '../types/role.js';
import { BusinessError } from '../types/error.js';
import { AuthRequest } from './authHandler.js';
import { discordMemberRoleService } from '../services/discordMemberRole.service.js';
import { guildService } from '../services/guild.service.js';

type GuildIdSource = { from: 'body' | 'params' | 'query'; key: string };

/** 요청에서 guildId를 추출 */
const extractGuildId = (req: AuthRequest, source: GuildIdSource): string | undefined => {
  const target = req[source.from] as Record<string, unknown>;
  const value = target?.[source.key];
  return typeof value === 'string' ? value : undefined;
};

/**
 * 전역 Admin 검증 미들웨어
 * @param minRole - 최소 요구 권한 ('adminNormal' | 'adminSuper')
 *
 * @example
 * router.post('/', requireAdmin('adminNormal'), createGuild);
 */
export const requireAdmin =
  (minRole: Extract<Role, 'adminNormal' | 'adminSuper'>) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.isBot) return next();

      const memberId = req.discordMemberId;
      if (!memberId) {
        throw new BusinessError('Unauthorized', 401, { isLoggable: true });
      }

      const roles = await discordMemberRoleService.getActiveRoles(memberId);
      const adminRoles = roles.filter((r) => ADMIN_ROLES.includes(r.role as Role));
      const hasPermission = adminRoles.some((r) => hasMinRole(r.role as Role, minRole));

      if (!hasPermission) {
        throw new BusinessError('Forbidden: insufficient admin role', 403, { isLoggable: true });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };

/**
 * Guild 스코프 권한 판정. 미들웨어가 아니라 결과가 필요한 곳에서 쓴다 —
 * 권한에 따라 막는 대신 보여줄 범위를 좁히는 조회(신청 목록)는 403으로 끊으면 안 된다.
 * 봇은 미들웨어와 같은 이유로 통과: 권한 검사는 봇이 책임진다.
 */
export const hasGuildRole = async (
  req: AuthRequest,
  minRole: Role,
  guildId: string,
): Promise<boolean> => {
  if (req.isBot) return true;

  const memberId = req.discordMemberId;
  if (!memberId) return false;

  const roles = await discordMemberRoleService.getActiveRolesByGuild(memberId, guildId);

  // Admin bypass: adminNormal 이상이면 guildId 무관하게 통과
  const isAdmin = roles
    .filter((r) => ADMIN_ROLES.includes(r.role as Role))
    .some((r) => hasMinRole(r.role as Role, 'adminNormal'));
  if (isAdmin) return true;

  return roles.some((r) => hasMinRole(r.role as Role, minRole));
};

/**
 * Guild 스코프 역할 검증 미들웨어
 * - adminNormal 이상은 자동 bypass
 * @param minRole - 최소 요구 권한
 * @param source  - 요청에서 guildId를 읽을 위치
 *
 * @example
 * router.put('/status', requireGuildRole('guildManager', { from: 'body', key: 'guildId' }), handler);
 */
export const requireGuildRole =
  (minRole: Role, source: GuildIdSource) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.isBot) return next();

      const memberId = req.discordMemberId;
      if (!memberId) {
        throw new BusinessError('Unauthorized', 401, { isLoggable: true });
      }

      const guildId = extractGuildId(req, source);
      if (!guildId) {
        throw new BusinessError('guildId is required', 400, { isLoggable: true });
      }

      if (!(await hasGuildRole(req, minRole, guildId))) {
        throw new BusinessError('Forbidden: insufficient guild role', 403, { isLoggable: true });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };

/**
 * 웹 리플레이 업로드 권한 검증 미들웨어
 * - guild.allowAllUploads = true → 인증된 유저면 모두 허용
 * - guild.allowAllUploads = false → userUploader 이상 필요
 * - adminNormal 이상 → bypass
 * @param source - 요청에서 guildId를 읽을 위치
 */
export const requireUploadPermission =
  (source: GuildIdSource) =>
  async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.isBot) return next();

      const memberId = req.discordMemberId;
      if (!memberId) {
        throw new BusinessError('Unauthorized', 401, { isLoggable: true });
      }

      const guildId = extractGuildId(req, source);
      if (!guildId) {
        throw new BusinessError('guildId is required', 400, { isLoggable: false });
      }

      const guildData = await guildService.findGuildById(guildId);
      if (!guildData) {
        throw new BusinessError('Guild not found', 400, { isLoggable: false });
      }

      const roles = await discordMemberRoleService.getActiveRolesByGuild(memberId, guildId);

      // Admin bypass: adminNormal 이상이면 무조건 통과
      const isAdmin = roles
        .filter((r) => ADMIN_ROLES.includes(r.role as Role))
        .some((r) => hasMinRole(r.role as Role, 'adminNormal'));
      if (isAdmin) return next();

      // allowAllUploads = true → 인증된 유저면 통과
      if (guildData.allowAllUploads) return next();

      // allowAllUploads = false → userUploader 이상 필요
      const hasPermission = roles.some((r) => hasMinRole(r.role as Role, 'userUploader'));

      if (!hasPermission) {
        throw new BusinessError('Forbidden: insufficient upload permission', 403, { isLoggable: true });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
