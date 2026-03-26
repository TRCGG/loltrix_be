-- system_config 테이블 생성
CREATE TABLE IF NOT EXISTS system_config (
  key VARCHAR(128) PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  update_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 초기 설정값 삽입
INSERT INTO system_config (key, value, description) VALUES
  ('LOL_SEASON', '2026', 'LoL 현재 시즌'),
  ('STATS_MIN_GAME_COUNT', '5', '통계 최소 게임 수 (승률 정렬 시)'),
  ('COOKIE_DOMAIN', '.gmok.kr', '쿠키 도메인'),
  ('FRONTEND_URL_PROD', 'https://gmok.kr', '프론트엔드 URL (운영)'),
  ('FRONTEND_URL_DEV', 'https://dev.gmok.kr', '프론트엔드 URL (개발)'),
  ('MAX_REPLAY_FILE_SIZE', '52428800', '리플레이 파일 최대 크기 (bytes)'),
  ('DISCORD_OAUTH_SCOPES', 'identify,guilds,guilds.members.read', 'Discord OAuth 스코프 (쉼표 구분)')
ON CONFLICT (key) DO NOTHING;
