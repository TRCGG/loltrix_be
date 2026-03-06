import { Response, NextFunction } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../database/connectionPool.js';
import { discordMemberRole } from '../database/schema.js';
import { Role, ADMIN_ROLES, hasMinRole } from '../types/role.js';
import { BusinessError } from '../types/error.js';
import { AuthRequest } from './authHandler.js';

type GuildIdSource = { from: 'body' | 'params' | 'query'; key: string };

/** 요청에서 guildId를 추출 */
const extractGuildId = (req: AuthRequest, source: GuildIdSource): string | undefined => {
  const target = req[source.from] as Record<string, unknown>;
  const value = target?.[source.key];
  return typeof value === 'string' ? value : undefined;
};

/** memberId의 활성 권한 목록 조회 */
const getActiveRoles = async (memberId: string) =>
  db
    .select()
    .from(discordMemberRole)
    .where(and(eq(discordMemberRole.memberId, memberId), eq(discordMemberRole.isDeleted, false)));

/** memberId가 adminNormal 이상인지 확인 (컨트롤러/서비스 레이어에서 직접 사용) */
export const checkIsAdmin = async (memberId: string): Promise<boolean> => {
  const roles = await getActiveRoles(memberId);
  return roles
    .filter((r) => ADMIN_ROLES.includes(r.role as Role))
    .some((r) => hasMinRole(r.role as Role, 'adminNormal'));
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

      const roles = await getActiveRoles(memberId);
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

      const roles = await getActiveRoles(memberId);

      // Admin bypass: adminNormal 이상이면 guildId 무관하게 통과
      const isAdmin = roles
        .filter((r) => ADMIN_ROLES.includes(r.role as Role))
        .some((r) => hasMinRole(r.role as Role, 'adminNormal'));

      if (isAdmin) return next();

      // Guild 스코프 권한 검증
      const hasPermission = roles
        .filter((r) => r.guildId === guildId)
        .some((r) => hasMinRole(r.role as Role, minRole));

      if (!hasPermission) {
        throw new BusinessError('Forbidden: insufficient guild role', 403, { isLoggable: true });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
