const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 한국은 서머타임이 없어 고정 오프셋으로 계산해도 서버 시간대와 무관하게 정확하다.
const KST_OFFSET_MS = 9 * HOUR_MS;
const IN_FLIGHT_MS = 60 * 1000;

/**
 * @desc now 이후 처음 오는 KST 기준 refreshHour 정각의 epoch ms를 반환합니다.
 */
export const nextRefreshAt = (now: number, refreshHour: number): number => {
  const kstMidnight = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  const todayRefresh = kstMidnight + refreshHour * HOUR_MS;
  return now < todayRefresh ? todayRefresh : todayRefresh + DAY_MS;
};

/**
 * @desc 같은 키의 계산 결과를 다음 KST 갱신 시각까지 재사용하는 프로세스 메모리 캐시입니다.
 */
export class DailyCache {
  private readonly entries = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(
    private readonly refreshHour: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  public get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > now) return cached.value as Promise<T>;
    this.entries.delete(key);

    // 계산 중인 Promise를 저장해야 동시에 들어온 같은 요청이 집계를 한 번만 실행한다.
    // DB 풀에 쿼리 타임아웃이 없어 응답 없는 계산이 다음 갱신 시각까지 키를 막지 않도록,
    // 완료 전에는 짧게만 재사용하고 완료되면 그때 다음 갱신 시각으로 늘린다.
    const value = load();
    const entry = { expiresAt: now + IN_FLIGHT_MS, value };
    this.entries.set(key, entry);
    value.then(
      () => {
        entry.expiresAt = nextRefreshAt(now, this.refreshHour);
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return value;
  }

  public clear() {
    this.entries.clear();
  }
}
