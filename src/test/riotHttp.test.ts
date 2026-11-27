import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

const { riotRequest } = await import('../clients/riot/riotHttp.js');

const respond = (status: number, body = '{}', headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : body, { status, headers });

const fetchMock = jest.fn<typeof fetch>();
const options = { route: '/matches/{matchId}', caller: 'test' };

describe('riotRequest', () => {
  const originalFetch = globalThis.fetch;
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    globalThis.fetch = fetchMock;
    fetchMock.mockReset();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    jest.useRealTimers();
  });

  test('실패 응답은 code에 upstream status를 싣는다', async () => {
    fetchMock.mockResolvedValue(respond(404, 'not found'));
    await expect(riotRequest('https://x', 'key', options)).rejects.toMatchObject({
      status: 502,
      code: 'riot_upstream_404',
    });
  });

  test('maxRateLimitRetry 0이면 429를 기다리지 않고 바로 실패한다', async () => {
    fetchMock.mockResolvedValue(respond(429, '', { 'Retry-After': '5' }));
    await expect(
      riotRequest('https://x', 'key', { ...options, maxRateLimitRetry: 0 }),
    ).rejects.toMatchObject({ code: 'riot_upstream_429' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('기본값은 429를 Retry-After만큼 기다려 최대 2회 재시도한다', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(respond(429, '', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(respond(429, '', { 'Retry-After': '1' }))
      .mockResolvedValueOnce(respond(200, '{"ok":true}'));

    const pending = riotRequest<{ ok: boolean }>('https://x', 'key', options);
    await jest.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
