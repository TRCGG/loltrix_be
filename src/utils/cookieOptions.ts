import { systemConfigService } from '../services/systemConfig.service.js';

const DEFAULT_COOKIE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

export async function getCookieOptions() {
  const [domain, maxAge] = await Promise.all([
    systemConfigService.getConfigOrDefault('COOKIE_DOMAIN', '.gmok.kr'),
    systemConfigService.getNumberConfig('COOKIE_MAX_AGE_MS', DEFAULT_COOKIE_MAX_AGE_MS),
  ]);

  return {
    domain,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'none' as const,
    maxAge,
  };
}
