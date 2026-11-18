import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { createPromiseCache } from '../utils/promiseCache.js';

const flush = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

afterEach(() => {
  jest.useRealTimers();
});

describe('createPromiseCache', () => {
  test('TTL 안에서는 진행 중인 조회를 공유한다', async () => {
    const cache = createPromiseCache<number>(60_000);
    const load = jest.fn(async () => 1);

    const [a, b] = await Promise.all([cache.get('k', load), cache.get('k', load)]);

    expect([a, b]).toEqual([1, 1]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('TTL이 지나면 다시 조회한다', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const cache = createPromiseCache<number>(60_000);
    const load = jest.fn(async () => 1);

    await cache.get('k', load);
    jest.advanceTimersByTime(60_000);
    expect(cache.peek('k')).toBeUndefined();
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  test('reject된 결과는 남기지 않는다', async () => {
    const cache = createPromiseCache<number>(60_000);

    await expect(cache.get('k', async () => Promise.reject(new Error('down')))).rejects.toThrow();
    await flush();

    expect(cache.peek('k')).toBeUndefined();
  });

  test('shouldEvict가 참인 결과는 남기지 않는다', async () => {
    const cache = createPromiseCache<number>(60_000, (value) => value < 0);

    await cache.get('bad', async () => -1);
    await cache.get('good', async () => 1);
    await flush();

    expect(cache.peek('bad')).toBeUndefined();
    expect(cache.peek('good')).toBeDefined();
  });

  test('늦게 실패한 옛 항목이 새 항목을 지우지 않는다', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const cache = createPromiseCache<number>(1_000);
    let rejectOld: (error: Error) => void = () => {};
    const old = cache.get(
      'k',
      () =>
        new Promise<number>((_, reject) => {
          rejectOld = reject;
        }),
    );

    jest.advanceTimersByTime(1_000);
    await cache.get('k', async () => 2);
    rejectOld(new Error('late'));
    await expect(old).rejects.toThrow();
    await flush();

    await expect(cache.peek('k')).resolves.toBe(2);
  });
});
