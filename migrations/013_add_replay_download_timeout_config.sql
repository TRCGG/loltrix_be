-- 리플 CDN 다운로드 데드라인(ms) 시드 (TRC-261).
-- 봇이 45초에 요청을 끊으므로 파싱·DB 저장 시간을 남겨야 한다.
INSERT INTO system_config (key, value, description) VALUES
  ('REPLAY_DOWNLOAD_TIMEOUT_MS', '20000', '리플 파일 CDN 다운로드 데드라인 (ms)')
ON CONFLICT (key) DO NOTHING;
