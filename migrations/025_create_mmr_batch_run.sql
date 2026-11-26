-- MMR 일일 배치 실행 기록. 배치는 마지막 done(또는 seed) 행의 cutoff_to 다음부터 이번 컷오프까지를 계산한다.
-- seed 행은 서비스 시작 때 한 번 넣는다 — 데이터팀 전체 계산이 자른 06:00 KST 컷오프 C(--seed=C)가 첫 구간의 시작점이다.
CREATE TABLE IF NOT EXISTS mmr_batch_run (
  id                 SERIAL        PRIMARY KEY,
  cutoff_from        TIMESTAMPTZ   NOT NULL,
  cutoff_to          TIMESTAMPTZ   NOT NULL,
  status             VARCHAR(16)   NOT NULL,
  guild_seasons      INTEGER       NOT NULL DEFAULT 0,
  processed_matches  INTEGER       NOT NULL DEFAULT 0,
  skipped_matches    JSONB         NOT NULL DEFAULT '[]'::jsonb,
  error              TEXT,
  started_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mmr_batch_run_status_cutoff ON mmr_batch_run (status, cutoff_to);
