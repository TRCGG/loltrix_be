type Entry<T> = { promise: Promise<T>; expiresAt: number };

const PRUNE_THRESHOLD = 1000;

/**
 * 키별로 진행 중인 조회 promise를 TTL 동안 공유한다 (값이 아니라 promise라 동시 요청이 조회 하나를 함께 기다린다).
 * reject됐거나 shouldEvict가 참인 결과는 지워 다음 요청이 다시 조회하게 한다 — 일시 장애가 TTL만큼 늘어나지 않게.
 * 프로세스 로컬이다.
 */
export const createPromiseCache = <T>(ttlMs: number, shouldEvict?: (value: T) => boolean) => {
  const entries = new Map<string, Entry<T>>();

  const pruneExpired = () => {
    const now = Date.now();
    entries.forEach((value, key) => {
      if (value.expiresAt <= now) entries.delete(key);
    });
  };

  const peek = (key: string): Promise<T> | undefined => {
    const cached = entries.get(key);
    return cached && cached.expiresAt > Date.now() ? cached.promise : undefined;
  };

  const get = (key: string, load: () => Promise<T>): Promise<T> => {
    const cached = peek(key);
    if (cached) return cached;

    if (entries.size > PRUNE_THRESHOLD) pruneExpired();

    const promise = load();
    const entry = { promise, expiresAt: Date.now() + ttlMs };
    entries.set(key, entry);

    // 그사이 새 항목이 들어왔으면 건드리지 않는다.
    const evict = () => {
      if (entries.get(key) === entry) entries.delete(key);
    };
    promise
      .then((value) => {
        if (shouldEvict?.(value)) evict();
      })
      .catch(evict);

    return promise;
  };

  return { peek, get };
};
