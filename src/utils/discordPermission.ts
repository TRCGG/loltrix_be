/** 서버 관리하기 (Manage Server) */
const MANAGE_GUILD = 1n << 5n;
/** 관리자 — 모든 권한 포함 */
const ADMINISTRATOR = 1n << 3n;

/**
 * @desc 해당 길드의 Discord 운영진(서버 관리하기 또는 관리자)인지 판정.
 * permissions는 64비트라 Discord가 문자열로 주므로 BigInt로만 다룬다(Number는 상위 비트 유실).
 */
export const isDiscordGuildManager = (permissions?: string | null): boolean => {
  if (!permissions) return false;

  let bits: bigint;
  try {
    bits = BigInt(permissions);
  } catch {
    console.warn(`[discordPermission] permissions 파싱 실패: ${permissions}`);
    return false;
  }

  return (bits & MANAGE_GUILD) !== 0n || (bits & ADMINISTRATOR) !== 0n;
};
