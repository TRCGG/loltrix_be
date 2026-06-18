-- =============================================================================
-- 005_add_mmr_system.sql  —  MMR 시스템 테이블 9종
-- 설계 SoT: docs/mmr/steps/step01_migration.md (테이블/컬럼명 기준)
--
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

-- 6. mmr_participant_metric ───────────────────────────────────────────────────
-- 구조: match_participant_metric 정의서(raw 49 + 파생 14). categoricals는 변환값 저장.
-- 자연키 (custom_match_id, puuid). raw/파생은 NULL 허용.
CREATE TABLE IF NOT EXISTS mmr_participant_metric (
  id                          BIGSERIAL PRIMARY KEY,
  -- 식별 / 메타
  custom_match_id             VARCHAR(255) NOT NULL,   -- = replay.replay_code
  puuid                       VARCHAR(128) NOT NULL,   -- rawData PUUID
  guild_id                    VARCHAR(128) NOT NULL,
  season                      VARCHAR(32)  NOT NULL,
  champion_id                 VARCHAR(16),             -- SKIN→champion.champ_name_eng (실패 시 NULL)
  game_team                   VARCHAR(8)   NOT NULL,   -- 변환값: TEAM 100→blue, 200→red
  position                    VARCHAR(8)   NOT NULL,   -- 변환값: JUNGLE→JUG/MIDDLE→MID/BOTTOM→ADC/UTILITY→SUP/TOP→TOP
  game_result                 SMALLINT     NOT NULL,   -- 변환값: WIN='Win'→1, else 0
  played_date                 TIMESTAMPTZ  NOT NULL,   -- 업로드 시각(raw에 게임시각 없음), 처리 순서 ASC 기준
  -- raw 지표 (JSON 키)
  kills                       INTEGER,   -- CHAMPIONS_KILLED
  deaths                      INTEGER,   -- NUM_DEATHS
  assists                     INTEGER,   -- ASSISTS
  double_kills                INTEGER,   -- DOUBLE_KILLS
  triple_kills                INTEGER,   -- TRIPLE_KILLS
  quadra_kills                INTEGER,   -- QUADRA_KILLS
  penta_kills                 INTEGER,   -- PENTA_KILLS
  killing_sprees              INTEGER,   -- KILLING_SPREES
  largest_killing_spree       INTEGER,   -- LARGEST_KILLING_SPREE
  gold_earned                 INTEGER,   -- GOLD_EARNED
  cc_time                     INTEGER,   -- TIME_CCING_OTHERS (초)
  game_duration               INTEGER,   -- TIME_PLAYED (초)
  damage_to_champions         INTEGER,   -- TOTAL_DAMAGE_DEALT_TO_CHAMPIONS
  damage_taken                INTEGER,   -- TOTAL_DAMAGE_TAKEN
  damage_self_mitigated       INTEGER,   -- TOTAL_DAMAGE_SELF_MITIGATED
  vision_score                INTEGER,   -- VISION_SCORE
  wards_placed                INTEGER,   -- WARD_PLACED
  wards_killed                INTEGER,   -- WARD_KILLED
  detector_wards_placed       INTEGER,   -- WARD_PLACED_DETECTOR
  control_wards_bought        INTEGER,   -- VISION_WARDS_BOUGHT_IN_GAME
  minions_killed              INTEGER,   -- MINIONS_KILLED
  neutral_minions_killed      INTEGER,   -- NEUTRAL_MINIONS_KILLED
  time_spent_dead             INTEGER,   -- TOTAL_TIME_SPENT_DEAD (초)
  longest_time_living         INTEGER,   -- LONGEST_TIME_SPENT_LIVING (초)
  damage_to_turrets           INTEGER,   -- TOTAL_DAMAGE_DEALT_TO_BUILDINGS
  damage_to_objectives        INTEGER,   -- TOTAL_DAMAGE_DEALT_TO_OBJECTIVES
  dragon_kills                INTEGER,   -- DRAGON_KILLS
  baron_kills                 INTEGER,   -- BARON_KILLS
  herald_kills                INTEGER,   -- RIFT_HERALD_KILLS
  horde_kills                 INTEGER,   -- HORDE_KILLS (공허 유충)
  last_takedown_time          INTEGER,   -- LAST_TAKEDOWN_TIME (마지막 처치 관여 시각, 초)
  turrets_killed              INTEGER,   -- TURRETS_KILLED (막타 파괴)
  turret_takedowns            INTEGER,   -- TURRET_TAKEDOWNS (철거 관여)
  level                       INTEGER,   -- LEVEL
  exp                         INTEGER,   -- EXP
  turret_plates_destroyed     INTEGER,   -- Missions_TurretPlatesDestroyed
  takedowns_under_turret      INTEGER,   -- Missions_TakedownsUnderTurret (포탑 아래 처치 관여)
  takedowns_before_15min      INTEGER,   -- Missions_TakedownsBefore15Min (15분 이전 처치 관여)
  jungle_cs_own               INTEGER,   -- NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE
  jungle_cs_enemy             INTEGER,   -- NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE
  damage_to_epic_monsters     INTEGER,   -- TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS (신포맷만)
  objectives_stolen           INTEGER,   -- OBJECTIVES_STOLEN
  barracks_killed             INTEGER,   -- BARRACKS_KILLED (억제기)
  heal_on_teammates           INTEGER,   -- TOTAL_HEAL_ON_TEAMMATES
  shield_on_teammates         INTEGER,   -- TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES
  enemy_missing_pings         INTEGER,   -- ENEMY_MISSING_PINGS
  retreat_pings               INTEGER,   -- RETREAT_PINGS
  on_my_way_pings             INTEGER,   -- ON_MY_WAY_PINGS
  command_pings               INTEGER,   -- COMMAND_PINGS
  -- 파생 지표 (raw에서 계산, 소수 2자리. canonical = backfill SQL)
  gold_per_min                NUMERIC,
  dpm                         NUMERIC,
  damage_taken_per_min        NUMERIC,
  cc_time_per_min             NUMERIC,
  exp_per_min                 NUMERIC,
  damage_to_turrets_per_min   NUMERIC,
  cs_per_min                  NUMERIC,
  wards_placed_per_min        NUMERIC,
  wards_killed_per_min        NUMERIC,
  kda                         NUMERIC,
  damage_taken_per_death      NUMERIC,
  damage_dealt_per_death      NUMERIC,
  dead_time_pct               NUMERIC,
  lane_gold_diff              NUMERIC,
  -- 파이프라인
  is_mmr_eligible             BOOLEAN      NOT NULL DEFAULT TRUE,  -- MMR 계산 적격 여부
  is_deleted                  BOOLEAN      NOT NULL DEFAULT FALSE, -- 리플 삭제 시 soft delete
  create_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_participant_metric_match_puuid UNIQUE (custom_match_id, puuid)
);

CREATE INDEX IF NOT EXISTS idx_mpm_guild_season_played
  ON mmr_participant_metric (guild_id, season, played_date DESC);
CREATE INDEX IF NOT EXISTS idx_mpm_custom_match
  ON mmr_participant_metric (custom_match_id);
CREATE INDEX IF NOT EXISTS idx_mpm_puuid_season
  ON mmr_participant_metric (puuid, season);

-- 7. mmr_match_result ─────────────────────────────────────────────────────────
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

-- 8. mmr_history (partitioned) ────────────────────────────────────────────────
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

-- 9. mmr_member_summary ───────────────────────────────────────────────────────
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
