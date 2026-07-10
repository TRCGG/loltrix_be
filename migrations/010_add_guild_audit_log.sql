-- 길드 관리 행위 통합 감사 로그 (append-only). 클랜관리 화면의 관리 로그 조회용.
-- 로그 종류마다 테이블을 늘리지 않고 하나로 통합한다:
--   공통 컬럼(guild/actor/target/시각) + 타입별 페이로드는 detail(jsonb).
-- 기존 discord_member_role_log(TRC-222, 역할 부여/회수 전용)를 이 테이블로 흡수한다.
-- "append-only 이벤트 이력으로 행위자를 보존한다"는 원 설계 의도(TRC-221 결정 #2)는 동일하게 유지.
-- (번호가 009가 아닌 010인 이유: 008이 두 개 존재해 그 다음 빈 번호부터 시작하기로 함)

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

-- 특정 멤버 대상 이력 조회 (기존 idx_dmrl_member_guild_created의 용도 승계)
CREATE INDEX IF NOT EXISTS idx_gal_guild_target_created
  ON guild_audit_log (guild_id, target_member_id, create_date);

-- 기존 역할 로그 데이터 이관 후 테이블 제거 (재실행 시 이미 제거됐으면 스킵 — idempotent)
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'discord_member_role_log'
  ) THEN
    INSERT INTO guild_audit_log (guild_id, event_type, actor_member_id, target_member_id, detail, create_date)
    SELECT guild_id,
           'roleChange',
           actor_member_id,
           member_id,
           jsonb_build_object('fromRole', from_role, 'toRole', to_role),
           create_date
    FROM discord_member_role_log;

    DROP TABLE discord_member_role_log;
  END IF;
END $$;
