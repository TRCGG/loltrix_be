-- 토너먼트 폴링 운영 파라미터를 system_config로 시드 (TRC-225).
-- 폴링 잡이 매 주기 읽으므로 DB에서 값을 바꾸면 재배포·재시작 없이 즉시 반영된다.
-- 행이 없어도 코드 기본값(1h / 3h)으로 동작 — 시드는 운영 가시성·조정 편의 목적.

INSERT INTO system_config (key, value, description) VALUES
  ('TOURNAMENT_POLL_MIN_AGE_HOURS', '1', '토너먼트 폴백 폴링: 발급 후 이 시간(시간) 이상 지난 PENDING 코드만 회수 대상'),
  ('TOURNAMENT_CODE_EXPIRE_HOURS', '3', '토너먼트 코드 만료: 발급 후 이 시간(시간) 지나도록 미사용(PENDING)이면 INVALID 전이')
ON CONFLICT (key) DO NOTHING;
