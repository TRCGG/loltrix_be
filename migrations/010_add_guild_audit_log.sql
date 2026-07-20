-- 길드 관리 행위 통합 감사 로그 (append-only). 클랜관리 화면의 관리 로그 조회용.
-- 로그 종류마다 테이블을 늘리지 않고 하나로 통합한다:
--   공통 컬럼(guild/actor/target/시각) + 타입별 페이로드는 detail(jsonb).
-- "append-only 이벤트 이력으로 행위자를 보존한다"는 원 설계 의도(TRC-221 결정 #2)는 동일하게 유지.
-- ※ 구 discord_member_role_log(TRC-222)의 이관·drop 로직은 제거됨(2026-07-20 정리) —
--    dev DB는 2026-07-13에 이관·drop 완료했고, 운영 DB엔 구 테이블이 생성된 적이 없다(009에서 제외).

CREATE TABLE IF NOT EXISTS guild_audit_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id         VARCHAR(128) NOT NULL,
  event_type       VARCHAR(32)  NOT NULL,   -- 'roleChange' | 'replayDelete' (추가 시 마이그레이션 불필요)
  actor_member_id  TEXT         NOT NULL,   -- 행위자 Discord id (미상이면 'bot')
  target_member_id TEXT,                    -- 대상 멤버 (roleChange), 없으면 NULL
  detail           JSONB        NOT NULL,   -- roleChange: {fromRole,toRole} / replayDelete: {gameId,source('web'|'bot')}
  create_date      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 길드 단위 관리 로그를 최신순으로 조회
CREATE INDEX IF NOT EXISTS idx_gal_guild_created
  ON guild_audit_log (guild_id, create_date DESC);

-- 특정 멤버 대상 이력 조회
CREATE INDEX IF NOT EXISTS idx_gal_guild_target_created
  ON guild_audit_log (guild_id, target_member_id, create_date);
