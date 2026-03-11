import { SystemError } from '../types/error.js';

const DEFAULT_TIMEOUT = 10000;

/**
 * @desc 타임아웃이 적용된 fetch 유틸
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new SystemError(`Discord API Request Timed out after ${timeout}ms`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
