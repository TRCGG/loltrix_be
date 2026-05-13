INSERT INTO system_config (key, value, description) VALUES
  ('COOKIE_MAX_AGE_MS', '2505600000', 'Session cookie max age in milliseconds');


ALTER TABLE auth_session
ADD COLUMN IF NOT EXISTS expires_date TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '29 days');
