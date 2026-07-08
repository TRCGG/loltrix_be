-- 008_add_replay_hash_index.sql
-- 리플 중복검사(replay.service.checkDuplicateByHash):
--   WHERE hash_data = ? AND guild_id = ? AND is_deleted = false
-- hash_data 무인덱스로 매 업로드마다 replay 전체 풀스캔이던 것을 인덱스로 해소한다.
-- replay 테이블이 커질수록 업로드가 느려지던 원인.
--
-- ⚠️ 운영 적용 시 테이블 쓰기 잠금을 피하려 CONCURRENTLY 사용.
--    CONCURRENTLY는 트랜잭션 블록 안에서 실행 불가 → psql에서 단독(비트랜잭션) 실행할 것.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_replay_hash_guild
  ON replay (hash_data, guild_id);
