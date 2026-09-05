/**
 * 대회 상태 전이 규칙. DB 접근은 호출자(competition.service)가 한다.
 */
import { COMPETITION_STATUS, CompetitionStatus } from '../types/competition.js';

/**
 * 종료 되돌리기(CLOSED → IN_PROGRESS)는 있어도 CLOSED → RECRUITING은 없다 —
 * 되돌린 대회는 진행중을 거쳐야 하고, 길드당 진행중 하나 제약을 그 지점에서 다시 받는다.
 */
const ALLOWED_TRANSITIONS: Record<CompetitionStatus, readonly CompetitionStatus[]> = {
  RECRUITING: [COMPETITION_STATUS.IN_PROGRESS],
  IN_PROGRESS: [COMPETITION_STATUS.RECRUITING, COMPETITION_STATUS.CLOSED],
  CLOSED: [COMPETITION_STATUS.IN_PROGRESS],
};

export const canTransition = (from: string, to: CompetitionStatus): boolean =>
  (ALLOWED_TRANSITIONS[from as CompetitionStatus] ?? []).includes(to);

/** 종료로 들어가면 종료 시각을 찍고, 종료에서 나오면 지운다 — 남겨두면 최근 종료 대회 정렬이 어긋난다. */
export const closeDateFor = (to: CompetitionStatus): Date | null =>
  to === COMPETITION_STATUS.CLOSED ? new Date() : null;
