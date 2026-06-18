-- =============================================================================
-- 008_add_mmr_system.sql  —  MMR 시스템 테이블 8종
-- 설계 SoT: docs/mmr/steps/step01_migration.md (테이블/컬럼명 기준)
--
-- · mmr_participant_metric은 007_add_mmr_participant_metric.sql이 소유(canonical). 여기엔 없음
-- · 통계 도메인(replay/custom_match/match_participant)은 건드리지 않음
-- · MMR 테이블 상호간 FK 없음 (guild/custom_match 까지만 FK). 논리키로 join
-- · mmr_history 는 monthly RANGE partition
-- · 멱등: 전부 IF NOT EXISTS
-- 생성 순서 = FK 의존 순서
-- =============================================================================

-- 1. guild_subscription ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS guild_subscription (
  id            SERIAL PRIMARY KEY,
  guild_id      VARCHAR(128) NOT NULL REFERENCES guild(id),
  service_key   VARCHAR(32)  NOT NULL,               -- 현재 'MMR' 고정 (확장 포인트)
  status        VARCHAR(16)  NOT NULL,               -- active / cancelled
  enabled_date  TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- 현재(최근) 활성화 시각
  ended_date    TIMESTAMPTZ,                         -- 최근 해지 시각(이력용; cleanup은 status='cancelled' 기준, 유예 없음)
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- 최초 구독 생성 시각 (불변)
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_guild_subscription_guild_service UNIQUE (guild_id, service_key)
);

-- 2. mmr_guild_state ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_guild_state (
  id            SERIAL PRIMARY KEY,
  guild_id      VARCHAR(128) NOT NULL,
  season        VARCHAR(32)  NOT NULL,
  status        VARCHAR(16)  NOT NULL,               -- wait_init / ready / error
  error_message TEXT,
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_guild_state_guild_season UNIQUE (guild_id, season)
);

-- 3. mmr_season_baseline ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_season_baseline (
  id                   SERIAL PRIMARY KEY,
  season               VARCHAR(32) NOT NULL,
  baseline_version     VARCHAR(32) NOT NULL,
  mmr_baseline         JSONB       NOT NULL,                  -- { f1_mean, f2_mean }
  game_impact_baseline JSONB       NOT NULL,                  -- { position_weights, outcome_stats }
  metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  is_active            BOOLEAN     NOT NULL DEFAULT FALSE,
  create_date          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_date          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_season_baseline_season_version UNIQUE (season, baseline_version)
);

-- 시즌당 active baseline 1개만
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmr_season_baseline_active_per_season
  ON mmr_season_baseline (season)
  WHERE is_active = TRUE;

-- 4. mmr_job ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_job (
  id                SERIAL PRIMARY KEY,
  guild_id          VARCHAR(128),                    -- INCREMENTAL_BATCH/RECALC 시 필수, CLEANUP은 null
  season            VARCHAR(32),
  job_type          VARCHAR(32) NOT NULL,            -- INCREMENTAL_BATCH / RECALC / CLEANUP
  status            VARCHAR(16) NOT NULL,            -- wait / run / done / fail / cancel
  attempts          INTEGER     NOT NULL DEFAULT 0,  -- 상한 config MMR_JOB_MAX_ATTEMPTS(=3)
  scheduled_date    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_date      TIMESTAMPTZ,
  finished_date     TIMESTAMPTZ,
  error_message     TEXT,
  create_date       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_date       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mmr_job_status_scheduled
  ON mmr_job (status, scheduled_date) WHERE status IN ('wait', 'run');
CREATE INDEX IF NOT EXISTS idx_mmr_job_guild_type_status
  ON mmr_job (guild_id, job_type, status);

-- 5. mmr_match_queue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_match_queue (
  custom_match_id   VARCHAR(255) PRIMARY KEY REFERENCES custom_match(id),
  guild_id          VARCHAR(128) NOT NULL,
  season            VARCHAR(32)  NOT NULL,
  status            VARCHAR(16)  NOT NULL,               -- wait / done / fail / skip
  error_message     TEXT,
  is_deleted        BOOLEAN      NOT NULL DEFAULT FALSE, -- 리플 삭제 시 soft delete
  create_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW(), -- 처리 딜레이(기본 60분) 판정 기준
  update_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mmr_match_queue_guild_season_status
  ON mmr_match_queue (guild_id, season, status, create_date);

-- 6. mmr_match_result ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_match_result (
  id                    BIGSERIAL PRIMARY KEY,
  calculation_id        VARCHAR(64)  NOT NULL,
  baseline_version      VARCHAR(32)  NOT NULL,
  guild_id              VARCHAR(128) NOT NULL,
  season                VARCHAR(32)  NOT NULL,
  custom_match_id       VARCHAR(255) NOT NULL,
  match_participant_id  INTEGER      NOT NULL,
  puuid                 VARCHAR(128) NOT NULL,
  position              VARCHAR(8)   NOT NULL,
  game_result           SMALLINT     NOT NULL,
  pre_game_mmr          INTEGER      NOT NULL,
  mmr_change            INTEGER      NOT NULL,
  post_game_mmr         INTEGER      NOT NULL,
  expected_score        NUMERIC(6,4) NOT NULL,
  actual_score          NUMERIC(6,4) NOT NULL,
  relative_factor       NUMERIC(6,4) NOT NULL,
  personal_factor       NUMERIC(6,4) NOT NULL,
  final_factor          NUMERIC(6,4) NOT NULL,
  is_deleted            BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  calculated_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_match_result_calc_mpid UNIQUE (calculation_id, match_participant_id)
);

CREATE INDEX IF NOT EXISTS idx_mmr_result_guild_season_puuid_calc
  ON mmr_match_result (guild_id, season, puuid, calculated_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_result_custom_match
  ON mmr_match_result (custom_match_id);

-- 7. mmr_history (partitioned) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_history (
  id                      BIGSERIAL,
  guild_id                VARCHAR(128) NOT NULL,
  season                  VARCHAR(32)  NOT NULL,
  puuid                   VARCHAR(128) NOT NULL,
  custom_match_id         VARCHAR(255) NOT NULL,
  position                VARCHAR(8)   NOT NULL,
  mmr_delta               INTEGER      NOT NULL,
  before_mmr              INTEGER      NOT NULL,
  after_mmr               INTEGER      NOT NULL,
  before_pos_mmr          INTEGER      NOT NULL,
  after_pos_mmr           INTEGER      NOT NULL,
  mmr_match_result_id     BIGINT       NOT NULL,   -- → mmr_match_result.id (FK 제약은 안 검)
  is_deleted              BOOLEAN      NOT NULL DEFAULT FALSE,
  create_date             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, create_date)
) PARTITION BY RANGE (create_date);

-- 초기 파티션 6개월치 (2026-06 ~ 2026-12). 이후는 step12 monthly cron이 생성.
CREATE TABLE IF NOT EXISTS mmr_history_202606 PARTITION OF mmr_history FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS mmr_history_202607 PARTITION OF mmr_history FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS mmr_history_202608 PARTITION OF mmr_history FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS mmr_history_202609 PARTITION OF mmr_history FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS mmr_history_202610 PARTITION OF mmr_history FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS mmr_history_202611 PARTITION OF mmr_history FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS mmr_history_202612 PARTITION OF mmr_history FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE INDEX IF NOT EXISTS idx_mmr_history_202606_guild_season_puuid_create ON mmr_history_202606 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202607_guild_season_puuid_create ON mmr_history_202607 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202608_guild_season_puuid_create ON mmr_history_202608 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202609_guild_season_puuid_create ON mmr_history_202609 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202610_guild_season_puuid_create ON mmr_history_202610 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202611_guild_season_puuid_create ON mmr_history_202611 (guild_id, season, puuid, create_date DESC);
CREATE INDEX IF NOT EXISTS idx_mmr_history_202612_guild_season_puuid_create ON mmr_history_202612 (guild_id, season, puuid, create_date DESC);

-- 8. mmr_member_summary ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmr_member_summary (
  guild_id          VARCHAR(128) NOT NULL,
  season            VARCHAR(32)  NOT NULL,
  puuid             VARCHAR(128) NOT NULL,
  -- MMR 값은 DB default 미지정 — 앱이 초기값(현재 1300, config로 관리·변경 여지)으로 세팅. games/wins만 0 default.
  total_mmr         INTEGER      NOT NULL,
  total_games       INTEGER      NOT NULL DEFAULT 0,
  total_wins        INTEGER      NOT NULL DEFAULT 0,
  top_mmr  INTEGER NOT NULL, top_games INTEGER NOT NULL DEFAULT 0, top_wins INTEGER NOT NULL DEFAULT 0,
  jug_mmr  INTEGER NOT NULL, jug_games INTEGER NOT NULL DEFAULT 0, jug_wins INTEGER NOT NULL DEFAULT 0,
  mid_mmr  INTEGER NOT NULL, mid_games INTEGER NOT NULL DEFAULT 0, mid_wins INTEGER NOT NULL DEFAULT 0,
  adc_mmr  INTEGER NOT NULL, adc_games INTEGER NOT NULL DEFAULT 0, adc_wins INTEGER NOT NULL DEFAULT 0,
  sup_mmr  INTEGER NOT NULL, sup_games INTEGER NOT NULL DEFAULT 0, sup_wins INTEGER NOT NULL DEFAULT 0,
  is_deleted        BOOLEAN      NOT NULL DEFAULT FALSE,   -- 구독 해지 시 리더보드 숨김 (cleanup은 status='cancelled' 기준)
  update_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, season, puuid)
);

CREATE INDEX IF NOT EXISTS idx_mmr_member_summary_leaderboard
  ON mmr_member_summary (guild_id, season, total_mmr DESC)
  WHERE is_deleted = FALSE;
