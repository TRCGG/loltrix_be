-- match_participant에 PK 외 인덱스가 없어 경기→참가자 조인과 선수별 조회가 매번 전체 스캔한다.
-- 누락 인덱스를 추가하고, 같은 키를 이미 다른 인덱스가 덮는 중복 인덱스를 정리한다.
--
-- ⚠️ CONCURRENTLY는 트랜잭션 블록 안에서 실행 불가 → 문장 하나씩 단독(비트랜잭션) 실행할 것.
--    psql -f는 가능, psql -1(단일 트랜잭션)은 실패한다.
-- ⚠️ CONCURRENTLY는 오래 열린 트랜잭션이 끝날 때까지 대기한다(lock_timeout으로 못 끊음). 실행 전 확인:
--
-- SELECT pid, state, xact_start FROM pg_stat_activity WHERE xact_start < now() - interval '1 min';
--
-- ⚠️ 생성이 중간에 실패하면 INVALID 인덱스가 남고 IF NOT EXISTS가 그걸 건너뛴다.
--    재실행 전에 아래로 확인하고, 남아 있으면 DROP INDEX CONCURRENTLY 후 다시 만든다.
--
-- SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;

-- ── 추가 ──

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participant_custom_match
ON match_participant (custom_match_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_replay_guild_created_active
ON replay (guild_id, create_date DESC)
WHERE is_deleted = false;

-- 005 재적용. 운영엔 match_participant 것만 빠져 있고, dev엔 005 전체가 빠져 있다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_participant_active_player_match
ON match_participant (player_code, custom_match_id)
WHERE is_deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_custom_match_active_guild_season_created
ON custom_match (guild_id, season, create_date DESC, id)
WHERE is_deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_guild_member_active_account_guild
ON guild_member (account, guild_id)
WHERE is_main = true
  AND status = '1'
  AND is_deleted = false;

-- ── 삭제 ──

-- 017의 uq_replay_hash_guild_active가 같은 키를 덮는다. 중복검사도 is_deleted = false로 걸러 partial로 충분하다.
DROP INDEX CONCURRENTLY IF EXISTS idx_replay_hash_guild;

-- error_code UNIQUE 제약(error_log_error_code_key)과 같은 키.
DROP INDEX CONCURRENTLY IF EXISTS idx_error_log_error_code;

-- 레포 밖에서 생긴 인덱스. uq_member_guild (member_id, guild_id)가 같은 조회를 덮는다.
DROP INDEX CONCURRENTLY IF EXISTS idx_discord_member_role_member_guild;
DROP INDEX CONCURRENTLY IF EXISTS idx_discord_member_role_member_id;

-- 레포 밖에서 생긴 제약. 014의 uq_guild_member_guild_account와 키가 같다.
-- 014 쪽이 없거나 INVALID인 환경에서 지우면 유니크가 사라져 ON CONFLICT (guild_id, account)가
-- 42P10으로 실패하므로 먼저 확인한다. ACCESS EXCLUSIVE 락 대기 중엔 뒤 쿼리가 모두 막히니
-- 짧게 끊고, 실패하면 한가한 시간에 재시도한다.
BEGIN;
SET LOCAL lock_timeout = '1s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('uq_guild_member_guild_account')
      AND indisvalid AND indisunique AND indpred IS NULL
  ) THEN
    RAISE EXCEPTION 'uq_guild_member_guild_account 없음/INVALID — 제약 DROP 중단';
  END IF;
END $$;
ALTER TABLE guild_member DROP CONSTRAINT IF EXISTS guild_member_guild_id_account_unq;
COMMIT;
