-- 리플 중복 저장(같은 파일이 두 번 등록되는 것)을 DB에서 막는다.
-- replaySave는 checkDuplicateByHash로 확인한 뒤 insert 하는데, READ COMMITTED에서
-- 동시 업로드 두 건이 서로의 미커밋 insert를 못 보고 둘 다 통과한다. 봇이 45초에
-- 요청을 끊어 사용자가 첫 처리 중에 재업로드하므로 실제로 발생하며, 매치·참가자·
-- MMR 지표까지 통째로 중복 적재돼 전적이 이중 집계된다.
-- 애플리케이션 사전 검사만으로는 원천 차단이 불가능해 유니크 인덱스로 직렬화한다.
--
-- ⚠️ CONCURRENTLY는 트랜잭션 블록 안에서 실행 불가 → psql에서 단독(비트랜잭션) 실행할 것.
-- ⚠️ 이미 활성 중복이 있으면 인덱스 생성이 실패한다(INVALID 인덱스가 남으면 DROP 후 재시도).
--    적용 전에 아래로 중복 여부를 먼저 확인하고, 있으면 남길 한 건 외에는 is_deleted 처리한다.
--
-- SELECT hash_data, guild_id, count(*)
--   FROM replay
--  WHERE is_deleted = false
--  GROUP BY hash_data, guild_id
-- HAVING count(*) > 1;
--
-- idx_replay_hash_guild(008)은 이 인덱스와 선두 컬럼이 같아 중복이 되지만,
-- 이 마이그레이션에서는 건드리지 않는다. 안정화 후 별도로 DROP 해도 된다.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_replay_hash_guild_active
  ON replay (hash_data, guild_id)
  WHERE is_deleted = false;
