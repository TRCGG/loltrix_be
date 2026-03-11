export const ROLES = [
  'userNormal',
  'userUploader',
  'guildManager',
  'adminNormal',
  'adminSuper',
] as const;

export type Role = (typeof ROLES)[number];

/** 전역 권한 (guild_id 불필요) */
export const ADMIN_ROLES: readonly Role[] = ['adminNormal', 'adminSuper'] as const;

/** 역할 계층 순서 — index가 높을수록 상위 권한 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  userNormal: 0,
  userUploader: 1,
  guildManager: 2,
  adminNormal: 3,
  adminSuper: 4,
};

/** minRole 이상의 권한인지 확인 */
export const hasMinRole = (role: Role, minRole: Role): boolean =>
  ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[minRole];
