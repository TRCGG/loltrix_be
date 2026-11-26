// gmok_mmr(Python)와 결과를 소수점까지 맞추려면 정수(0에서 먼 쪽)와 실수(numpy) 반올림을 그대로 따라야 한다.

/** Python round_half_away_from_zero(float): float 값 그대로 비교해 정확히 .5인 값만 0에서 먼 쪽으로. */
export const roundHalfAwayFromZero = (x: number): number => {
  // Math.round는 음수 .5를 0 쪽으로 올리므로(-12.5 → -12) 절댓값으로 처리한다.
  const r = Math.round(Math.abs(x));
  if (r === 0) return 0;
  return x < 0 ? -r : r;
};

/** Python round_half_away_from_zero(Fraction(num, den)): 정수 비율을 오차 없이 반올림한다. */
export const roundRatioHalfAwayFromZero = (num: number, den: number): number => {
  const a = Math.abs(num);
  const whole = Math.floor(a / den);
  const remainder = a - whole * den;
  const r = whole + (2 * remainder >= den ? 1 : 0);
  if (r === 0) return 0;
  return num < 0 ? -r : r;
};

const rintHalfEven = (y: number): number => {
  const f = Math.floor(y);
  const diff = y - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
};

/** numpy.round / pandas .round(d): x·10^d를 짝수 쪽으로 rint한 뒤 10^d로 나눈다(연산 순서까지 numpy와 같다). */
export const roundNumpy = (x: number, decimals: number): number => {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** decimals;
  return rintHalfEven(x * f) / f;
};

/**
 * pandas groupby sum/mean과 같은 Kahan 보정 합. NaN은 건너뛰고 개수에서도 뺀다.
 * 단순 합과는 마지막 비트가 달라 반올림 경계에서 결과가 갈릴 수 있다.
 */
export const kahanSum = (values: readonly number[]): { sum: number; count: number } => {
  let sum = 0;
  let compensation = 0;
  let count = 0;
  for (const value of values) {
    if (Number.isNaN(value)) continue;
    count += 1;
    const y = value - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    sum = t;
  }
  return { sum, count };
};
