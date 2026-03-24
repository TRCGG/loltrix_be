import { fetchWithTimeout } from './fetchWithTimeout.js';

const VERSIONS_URL = 'https://ddragon.leagueoflegends.com/api/versions.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

let cache: { version: string; fetchedAt: number } | null = null;

/**
 * @desc Riot Data Dragon API에서 최신 패치버전을 가져옴 (24시간 인메모리 캐시)
 */
export async function getCurrentPatchVersion(): Promise<string | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.version;
  }

  try {
    const response = await fetchWithTimeout(VERSIONS_URL, { method: 'GET' }, 5000);

    if (!response.ok) {
      console.warn(`Patch version API returned status ${response.status}`);
      return cache?.version ?? null;
    }

    const versions: string[] = await response.json();
    const latest = versions[0];
    cache = { version: latest, fetchedAt: Date.now() };
    return latest;
  } catch (error) {
    console.warn('Failed to fetch patch version from Data Dragon:', error);
    return cache?.version ?? null;
  }
}
