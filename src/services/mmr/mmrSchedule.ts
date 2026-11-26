const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// 한국은 서머타임이 없어 고정 오프셋으로 계산해도 서버 시간대와 무관하게 정확하다.
const KST_OFFSET_MS = 9 * HOUR_MS;

export const MMR_CUTOFF_HOUR_KST = 6;
export const REPLAY_DELETE_GRACE_HOURS = 4;

const cutoffOfKstDay = (t: number): number => {
  const kstMidnight = Math.floor((t + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  return kstMidnight + MMR_CUTOFF_HOUR_KST * HOUR_MS;
};

/** t 이후(같은 시각 포함) 처음 오는 06:00 KST. 그 시각에 올라온 경기도 그 컷오프 구간에 든다. */
export const cutoffAtOrAfter = (t: Date): Date => {
  const candidate = cutoffOfKstDay(t.getTime());
  return new Date(candidate >= t.getTime() ? candidate : candidate + DAY_MS);
};

/** t 이전(같은 시각 포함) 가장 최근 06:00 KST. 배치 구간의 끝이다. */
export const cutoffAtOrBefore = (t: Date): Date => {
  const candidate = cutoffOfKstDay(t.getTime());
  return new Date(candidate <= t.getTime() ? candidate : candidate - DAY_MS);
};

/** 업로드된 리플을 지울 수 있는 마지막 시각(미포함). 그 경기가 처음 배치에 들어가기 직전이다. */
export const replayDeleteDeadline = (uploadedAt: Date): Date =>
  new Date(cutoffAtOrAfter(uploadedAt).getTime() + REPLAY_DELETE_GRACE_HOURS * HOUR_MS);

/**
 * 지금 계산해도 되는 구간의 끝: 삭제 마감까지 지난 가장 최근 컷오프.
 * 계산한 경기가 나중에 지워지면 되돌릴 수 없으므로(시간 구간 방식의 전제) 배치를 언제 돌려도
 * — PM2 재시작·배포·수동 실행 포함 — 마감 전 경기는 집지 않는다.
 */
export const calculableCutoff = (now: Date): Date =>
  cutoffAtOrBefore(
    // 마감 직전에 시작한 삭제 트랜잭션이 커밋을 마칠 여유
    new Date(now.getTime() - REPLAY_DELETE_GRACE_HOURS * HOUR_MS - 10 * 60 * 1000),
  );
