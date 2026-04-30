import { systemConfigService } from '../services/systemConfig.service.js';

export async function getCookieOptions() {
  const domain = await systemConfigService.getConfigOrDefault('COOKIE_DOMAIN', '.gmok.kr');
  return {
    domain,
    path: '/',
    secure: false,
    httpOnly: true,
    sameSite: 'lax' as const,
  };
}
