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

// maxAge를 남기면 express가 삭제용 expires를 그 값으로 덮어써서 쿠키가 안 지워진다.
export async function getClearCookieOptions() {
  const { maxAge, ...rest } = await getCookieOptions();
  return rest;
}
