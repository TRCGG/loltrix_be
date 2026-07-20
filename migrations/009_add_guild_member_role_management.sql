-- TRC-222 guildManager 웹 uploader 권한 부여/회수 기능용 테이블.
-- (구 008_add_guild_member_role_management — 008 중복을 해소하며 009로 리네임, 2026-07-20)
--
-- 전제: discord_member / discord_member_role 은 마이그레이션 체계 도입 전에 생성된 기존 테이블.
-- ※ 역할 감사 로그(discord_member_role_log)는 TRC-241에서 guild_audit_log로 흡수·폐기가
--    확정되어 본 파일에서 제외 — 010_add_guild_audit_log.sql이 통합 테이블을 생성한다.
--    (dev DB의 구 테이블은 2026-07-13 이관·drop 완료)

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

-- 멤버 관리 목록 API: discord_member_role을 guild_id로 필터 + update_date 정렬.
-- (기존 uq_member_guild는 member_id 선행이라 guild 단독 필터를 서빙하지 못해 seq scan 발생)
CREATE INDEX IF NOT EXISTS idx_dmr_guild_updated
  ON discord_member_role (guild_id, update_date DESC);
