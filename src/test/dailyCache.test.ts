import { jest, describe, test, expect } from '@jest/globals';
import { DailyCache, nextRefreshAt } from '../utils/dailyCache.js';

const at = (iso: string) => new Date(iso).getTime();

describe('nextRefreshAt', () => {
  test.each([
    ['2026-10-20T11:59:59+09:00', '2026-10-20T12:00:00+09:00'],
    ['2026-10-20T12:00:00+09:00', '2026-10-21T12:00:00+09:00'],
    ['2026-10-20T23:59:59+09:00', '2026-10-21T12:00:00+09:00'],
    ['2026-10-21T00:30:00+09:00', '2026-10-21T12:00:00+09:00'],
    ['2026-12-31T13:00:00+09:00', '2027-01-01T12:00:00+09:00'],
  ])('%s 다음 갱신은 KST %s다', (now, expected) => {
    expect(nextRefreshAt(at(now), 12)).toBe(at(expected));
  });
});

describe('DailyCache', () => {
  const createCache = (start: string, maxEntries = 10) => {
    let now = at(start);
    const cache = new DailyCache(12, maxEntries, () => now);
    return {
      cache,
      setNow: (iso: string) => {
        now = at(iso);
      },
    };
  };

  test('갱신 시각 전에는 같은 키를 다시 계산하지 않고, 갱신 시각부터 새로 계산한다', async () => {
    const { cache, setNow } = createCache('2026-10-20T13:00:00+09:00');
    const load = jest.fn<() => Promise<number>>();
    load.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('key', load)).toBe(1);
    setNow('2026-10-21T11:59:59+09:00');
    expect(await cache.get('key', load)).toBe(1);
    setNow('2026-10-21T12:00:00+09:00');
    expect(await cache.get('key', load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('키가 다르면 따로 계산한다', async () => {
    const { cache } = createCache('2026-10-20T13:00:00+09:00');
    expect(await cache.get('a', async () => 'a')).toBe('a');
    expect(await cache.get('b', async () => 'b')).toBe('b');
  });

  test('동시에 들어온 같은 요청은 계산을 한 번만 실행한다', async () => {
    const { cache } = createCache('2026-10-20T13:00:00+09:00');
    let resolve!: (value: string) => void;
    const load = jest.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );

    const first = cache.get('key', load);
    const second = cache.get('key', load);
    resolve('done');

    expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('응답 없는 계산은 1분 뒤 다음 요청에서 새로 계산한다', async () => {
    const { cache, setNow } = createCache('2026-10-20T13:00:00+09:00');
    const load = jest.fn<() => Promise<string>>();
    load.mockReturnValueOnce(new Promise<string>(() => {})).mockResolvedValueOnce('fresh');

    cache.get('key', load);
    setNow('2026-10-20T13:00:59+09:00');
    cache.get('key', load);
    expect(load).toHaveBeenCalledTimes(1);
    setNow('2026-10-20T13:01:00+09:00');
    expect(await cache.get('key', load)).toBe('fresh');
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('완료된 계산은 1분이 지나도 다음 갱신 시각까지 재사용한다', async () => {
    const { cache, setNow } = createCache('2026-10-20T13:00:00+09:00');
    const load = jest.fn(async () => 'value');

    await cache.get('key', load);
    setNow('2026-10-21T11:00:00+09:00');
    await cache.get('key', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('실패한 계산은 저장하지 않고 다음 요청에서 다시 계산한다', async () => {
    const { cache } = createCache('2026-10-20T13:00:00+09:00');
    const load = jest.fn<() => Promise<string>>();
    load.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce('ok');

    await expect(cache.get('key', load)).rejects.toThrow('db down');
    expect(await cache.get('key', load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('최대 개수를 넘으면 가장 먼저 저장한 키부터 버린다', async () => {
    const { cache } = createCache('2026-10-20T13:00:00+09:00', 2);
    const load = jest.fn(async () => 'value');

    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('c', load);
    await cache.get('b', load);
    await cache.get('a', load);

    expect(load).toHaveBeenCalledTimes(4);
  });
});
