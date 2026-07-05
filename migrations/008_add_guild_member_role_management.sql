-- TRC-222 guildManager 웹 uploader 권한 부여/회수 기능용 테이블.
-- 1) discord_guild_member: 길드별 Discord 별명 저장 (멤버 식별 표시명).
-- 2) discord_member_role_log: 역할 부여/회수 감사 로그 (append-only).

-- 길드별 Discord 별명 (member, guild 당 1행). 표시명 = nickname ?? discord_member.display_name ?? member_id.
CREATE TABLE IF NOT EXISTS discord_guild_member (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     TEXT         NOT NULL REFERENCES discord_member(id),
  guild_id      VARCHAR(128) NOT NULL,
  nickname      TEXT,                                              -- nick 없으면 NULL (부가정보)
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  is_deleted    BOOLEAN      NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_discord_guild_member UNIQUE (member_id, guild_id)
);

-- 역할 부여/회수 감사 로그 (append-only, update/delete 없음).
CREATE TABLE IF NOT EXISTS discord_member_role_log (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id        TEXT         NOT NULL,   -- 대상 멤버
  guild_id         VARCHAR(128) NOT NULL,
  actor_member_id  TEXT         NOT NULL,   -- 변경을 수행한 guildManager(또는 admin)
  from_role        VARCHAR(32)  NOT NULL,   -- 변경 전 역할
  to_role          VARCHAR(32)  NOT NULL,   -- 변경 후 역할
  create_date      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 특정 (member, guild)의 변경 이력을 시간순으로 조회.
CREATE INDEX IF NOT EXISTS idx_dmrl_member_guild_created
  ON discord_member_role_log (member_id, guild_id, create_date);

-- 멤버 관리 목록 API: discord_member_role을 guild_id로 필터 + update_date 정렬.
-- (기존 uq_member_guild는 member_id 선행이라 guild 단독 필터를 서빙하지 못해 seq scan 발생)
CREATE INDEX IF NOT EXISTS idx_dmr_guild_updated
  ON discord_member_role (guild_id, update_date DESC);
