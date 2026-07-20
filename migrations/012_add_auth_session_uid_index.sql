-- verifyAuth가 매 요청 조회하는 auth_session(session_uid) 풀스캔 해소.
-- auth_session은 삭제 없이 쌓이므로 방치 시 로그인 누적에 비례해 전 요청이 느려진다.
-- ⚠️ CONCURRENTLY는 트랜잭션 블록 안에서 실행 불가 → psql에서 단독 실행할 것.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_session_uid
  ON auth_session (session_uid);
