# step01 — DB 마이그레이션 (SQL DDL)

> 상위 문서: [00_overview.md](../00_overview.md) | [02_data_model.md](../02_data_model.md)
> 다음 step: [step02_schema.md](./step02_schema.md)
>
> **이 문서의 테이블명·컬럼명이 구현의 기준(SoT)이다.** 기존 코드가 다른 이름을 쓰면 코드가 잘못된 것이며, 설계 확정 후 코드를 이 문서에 맞춘다.

---

## 1. 목적 / 범위

MMR 시스템이 사용하는 **테이블 9종**을 한 번의 마이그레이션으로 생성한다.

- 통계 도메인(`replay`, `custom_match`, `match_participant`)은 **건드리지 않는다**. MMR은 그 위에 얹는다.
- `mmr_history`는 처음부터 **monthly RANGE partition**으로 만든다 (나중에 쪼개기 어려움 — [00_overview.md §8](../00_overview.md)).
- 이 step은 **DDL만** 책임진다. ORM 매핑은 [step02](./step02_schema.md), 데이터 로직은 step03+.

### 산출물

| 파일 | 내용 |
|---|---|
| `migrations/005_add_mmr_system.sql` | 아래 §3 전체 DDL |

> 현재 브랜치(`TRC-211-Back-MMR-API-작업`)는 MMR 코드가 없는 greenfield다. 마이그레이션은 004(쿠키 설정)까지 있으므로 **`005_add_mmr_system.sql`** 로 신규 작성한다.

---

## 2. 테이블 9종 (생성 순서 = FK 의존 순서)

| # | 테이블 | FK 의존 | 비고 |
|---|---|---|---|
| 1 | `guild_subscription` | `guild` | 구독 게이트 |
| 2 | `mmr_guild_state` | — | 계산 진행 상태 (recalc_flag 없음) |
| 3 | `mmr_season_baseline` | — | `guild_id` 없음 (시즌 공유) |
| 4 | `mmr_job` | — | 비동기 작업 큐 (step05에서 유지 확정) |
| 5 | `mmr_match_queue` | `custom_match` | 경기별 처리 상태, 처리 딜레이(기본 60분) 기준 `create_date` |
| 6 | `mmr_participant_metric` | — (raw_data 파싱) | **모든 길드 생성** (MMR 계산만 구독, 게이팅은 step03). 자연키 `(custom_match_id, puuid)` |
| 7 | `mmr_match_result` | — | 멱등 upsert 키 보유 |
| 8 | `mmr_history` | — | **partitioned** |
| 9 | `mmr_member_summary` | — | 유저별 현재 MMR (SoT) |

> FK는 `guild` / `custom_match` / `match_participant`까지만 건다. MMR 테이블 상호간은 FK 없이 `guild_id+season+puuid` 등 논리키로 join (파티션·대량 삭제·재구독 복구 유연성 확보).

---

## 3. DDL

### 3.1 guild_subscription

```sql
CREATE TABLE IF NOT EXISTS guild_subscription (
  id            SERIAL PRIMARY KEY,
  guild_id      VARCHAR(128) NOT NULL REFERENCES guild(id),
  service_key   VARCHAR(32)  NOT NULL,              -- 현재 'MMR' 고정 (확장 포인트)
  status        VARCHAR(16)  NOT NULL,              -- active / cancelled
  enabled_date  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),-- 현재(최근) 활성화 시각
  ended_date    TIMESTAMPTZ,                        -- 최근 해지 시각 (이력용; cleanup은 status='cancelled' 기준, 유예 없음)
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),-- 최초 구독 생성 시각 (불변)
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_guild_subscription_guild_service UNIQUE (guild_id, service_key)
);
```

### 3.2 mmr_guild_state

```sql
CREATE TABLE IF NOT EXISTS mmr_guild_state (
  id            SERIAL PRIMARY KEY,
  guild_id      VARCHAR(128) NOT NULL,
  season        VARCHAR(32)  NOT NULL,
  status        VARCHAR(16)  NOT NULL,        -- wait_init / ready / error
  error_message TEXT,
  create_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  update_date   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_guild_state_guild_season UNIQUE (guild_id, season)
);
```

> RECALC는 **구독·재구독 시에만** 발생한다(삭제는 역산 롤백 — [step14](./step14_deletion_rollback.md)). 따라서 `recalc_flag`를 두지 않는다. 동시성은 행 잠금이 아니라 **`mmr_job` 큐 단일화**가 담당([01 §E](../01_architecture.md), [step05](./step05_job_queue.md)).

### 3.3 mmr_season_baseline

```sql
CREATE TABLE IF NOT EXISTS mmr_season_baseline (
  id                   SERIAL PRIMARY KEY,
  season               VARCHAR(32) NOT NULL,
  baseline_version     VARCHAR(32) NOT NULL,
  mmr_baseline         JSONB       NOT NULL,         -- { f1_mean, f2_mean }
  game_impact_baseline JSONB       NOT NULL,         -- { position_weights, outcome_stats }
  metadata             JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- { match_count, row_count }
  is_active            BOOLEAN     NOT NULL DEFAULT FALSE,
  create_date          TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- 계산 반영 시각
  update_date          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mmr_season_baseline_season_version UNIQUE (season, baseline_version)
);

-- 시즌당 active baseline 1개만 (partial unique)
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmr_season_baseline_active_per_season
  ON mmr_season_baseline (season)
  WHERE is_active = TRUE;
```

### 3.4 mmr_job

```sql
CREATE TABLE IF NOT EXISTS mmr_job (
  id                SERIAL PRIMARY KEY,
  guild_id          VARCHAR(128),                    -- INCREMENTAL_BATCH/RECALC 시 필수, CLEANUP은 null
  season            VARCHAR(32),
  job_type          VARCHAR(32) NOT NULL,            -- INCREMENTAL_BATCH / RECALC / CLEANUP
  status            VARCHAR(16) NOT NULL,            -- wait / run / done / fail / cancel
  attempts          INTEGER     NOT NULL DEFAULT 0,  -- 상한은 config MMR_JOB_MAX_ATTEMPTS(=3)
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
```

> `job_type`은 `INCREMENTAL_BATCH`/`RECALC`/`CLEANUP` 3종(step05 동시성 결정 — incremental도 큐로 직렬화). **BASELINE은 동기 admin API라 큐 제외.** enum은 DB 강제 안 하고 step05·코드에서 관리.

### 3.5 mmr_match_queue

```sql
CREATE TABLE IF NOT EXISTS mmr_match_queue (
  custom_match_id   VARCHAR(255) PRIMARY KEY REFERENCES custom_match(id),
  guild_id          VARCHAR(128) NOT NULL,
  season            VARCHAR(32)  NOT NULL,
  status            VARCHAR(16)  NOT NULL,           -- wait / done / fail / skip
  error_message     TEXT,
  is_deleted        BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  create_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- ⭐ 처리 딜레이(기본 60분) 판정 기준
  update_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mmr_match_queue_guild_season_status
  ON mmr_match_queue (guild_id, season, status, create_date);
```

### 3.6 mmr_participant_metric

> **구조 기준**: MMR 팀 `match_participant_metric` 정의서([match_participant_metric_table_spec.md](../match_participant_metric_table_spec.md)) — raw 49 + 파생 14.
> **값 형식 차이**: 정의서는 라이엇 원본값(`team=100/200`, `position=JUNGLE/…`, `win=bool`)을 저장하지만, **우리는 변환값을 저장**한다 — `game_team=blue/red`, `position=TOP/JUG/MID/ADC/SUP`, `game_result=1/0`. 그래서 전송(interface) 변환은 **필드명 리네임만** 남는다([step08 §5](./step08_incremental_worker.md)).

```sql
CREATE TABLE IF NOT EXISTS mmr_participant_metric (
  id                          BIGSERIAL PRIMARY KEY,                  -- 내부 PK
  -- ── 식별 / 메타 ───────────────────────────────────────────────
  custom_match_id             VARCHAR(255) NOT NULL,   -- 경기 식별자 (= replay.replay_code)
  puuid                       VARCHAR(128) NOT NULL,   -- 유저 식별자 (rawData PUUID)
  guild_id                    VARCHAR(128) NOT NULL,   -- 길드(디스코드 서버) id
  season                      VARCHAR(32)  NOT NULL,   -- 시즌 (system_config LOL_SEASON)
  champion_id                 VARCHAR(16),             -- 챔피언 id (SKIN→champion.champ_name_eng 매핑, 실패 시 NULL)
  game_team                   VARCHAR(8)   NOT NULL,   -- 팀 (변환값: TEAM 100→blue, 200→red)
  position                    VARCHAR(8)   NOT NULL,   -- 포지션 (변환값: JUNGLE→JUG/MIDDLE→MID/BOTTOM→ADC/UTILITY→SUP/TOP→TOP)
  game_result                 SMALLINT     NOT NULL,   -- 승패 (변환값: WIN='Win'→1, 'Fail' 등→0)
  played_date                 TIMESTAMPTZ  NOT NULL,   -- 경기 플레이 시각 (raw에 없어 업로드 시각 사용, 처리 순서 ASC 기준)
  -- ── raw 지표 (replay.raw_data JSON 파싱, 정의서 §2.2). 누락 키는 NULL ──
  kills                       INTEGER,   -- 킬 (CHAMPIONS_KILLED)
  deaths                      INTEGER,   -- 데스 (NUM_DEATHS)
  assists                     INTEGER,   -- 어시스트 (ASSISTS)
  double_kills                INTEGER,   -- 더블킬 수 (DOUBLE_KILLS)
  triple_kills                INTEGER,   -- 트리플킬 수 (TRIPLE_KILLS)
  quadra_kills                INTEGER,   -- 쿼드라킬 수 (QUADRA_KILLS)
  penta_kills                 INTEGER,   -- 펜타킬 수 (PENTA_KILLS)
  killing_sprees              INTEGER,   -- 연속 킬(킬 행진) 횟수 (KILLING_SPREES)
  largest_killing_spree       INTEGER,   -- 최다 연속 킬 (LARGEST_KILLING_SPREE)
  gold_earned                 INTEGER,   -- 획득 골드 (GOLD_EARNED)
  cc_time                     INTEGER,   -- CC 기여 시간(초) (TIME_CCING_OTHERS)
  game_duration               INTEGER,   -- 경기 시간(초) (TIME_PLAYED)
  damage_to_champions         INTEGER,   -- 챔피언 대상 피해 (TOTAL_DAMAGE_DEALT_TO_CHAMPIONS)
  damage_taken                INTEGER,   -- 받은 피해 (TOTAL_DAMAGE_TAKEN)
  damage_self_mitigated       INTEGER,   -- 경감 피해 (TOTAL_DAMAGE_SELF_MITIGATED)
  vision_score                INTEGER,   -- 시야 점수 (VISION_SCORE)
  wards_placed                INTEGER,   -- 설치 와드 (WARD_PLACED)
  wards_killed                INTEGER,   -- 파괴 와드 (WARD_KILLED)
  detector_wards_placed       INTEGER,   -- 핑크와드(투명감지) 설치 (WARD_PLACED_DETECTOR)
  control_wards_bought        INTEGER,   -- 제어와드 구매 (VISION_WARDS_BOUGHT_IN_GAME)
  minions_killed              INTEGER,   -- 미니언 CS (MINIONS_KILLED)
  neutral_minions_killed      INTEGER,   -- 정글 CS (NEUTRAL_MINIONS_KILLED)
  time_spent_dead             INTEGER,   -- 사망 상태 시간(초) (TOTAL_TIME_SPENT_DEAD)
  longest_time_living         INTEGER,   -- 최장 생존 시간(초) (LONGEST_TIME_SPENT_LIVING)
  damage_to_turrets           INTEGER,   -- 건물(포탑 등) 피해 (TOTAL_DAMAGE_DEALT_TO_BUILDINGS)
  damage_to_objectives        INTEGER,   -- 오브젝트 피해 (TOTAL_DAMAGE_DEALT_TO_OBJECTIVES)
  dragon_kills                INTEGER,   -- 처치한 드래곤 수 (DRAGON_KILLS)
  baron_kills                 INTEGER,   -- 처치한 바론 수 (BARON_KILLS)
  herald_kills                INTEGER,   -- 처치한 전령 수 (RIFT_HERALD_KILLS)
  horde_kills                 INTEGER,   -- 공허 유충 처치 수 (HORDE_KILLS)
  last_takedown_time          INTEGER,   -- 마지막 처치 관여(킬/어시) 시각(초, 게임 시작 기준) (LAST_TAKEDOWN_TIME)
  turrets_killed              INTEGER,   -- 막타로 파괴한 포탑 수 (TURRETS_KILLED)
  turret_takedowns            INTEGER,   -- 철거 관여한 포탑 수 (TURRET_TAKEDOWNS)
  level                       INTEGER,   -- 최종 레벨 (LEVEL)
  exp                         INTEGER,   -- 경험치 (EXP)
  turret_plates_destroyed     INTEGER,   -- 포탑 방패 파괴 수 (Missions_TurretPlatesDestroyed)
  takedowns_under_turret      INTEGER,   -- 포탑 아래에서 올린 처치 관여(킬/어시) 수 (Missions_TakedownsUnderTurret)
  takedowns_before_15min      INTEGER,   -- 15분 이전 처치 관여(킬/어시) 수 (Missions_TakedownsBefore15Min)
  jungle_cs_own               INTEGER,   -- 아군 정글 CS (NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE)
  jungle_cs_enemy             INTEGER,   -- 적군 정글 CS (NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE)
  damage_to_epic_monsters     INTEGER,   -- 에픽 몬스터 피해 (TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS, 신포맷만)
  objectives_stolen           INTEGER,   -- 스틸한 오브젝트 수 (OBJECTIVES_STOLEN)
  barracks_killed             INTEGER,   -- 파괴한 억제기 수 (BARRACKS_KILLED)
  heal_on_teammates           INTEGER,   -- 아군 힐량 (TOTAL_HEAL_ON_TEAMMATES)
  shield_on_teammates         INTEGER,   -- 아군 실드량 (TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES)
  enemy_missing_pings         INTEGER,   -- 적 미아(사라짐) 핑 수 (ENEMY_MISSING_PINGS)
  retreat_pings               INTEGER,   -- 후퇴 핑 수 (RETREAT_PINGS)
  on_my_way_pings             INTEGER,   -- "가는 중" 핑 수 (ON_MY_WAY_PINGS)
  command_pings               INTEGER,   -- 지휘(명령) 핑 수 (COMMAND_PINGS)
  -- ── 파생 지표 (raw에서 계산, 정의서 §2.3/§3, 소수 2자리). canonical 공식 = backfill SQL ──
  gold_per_min                NUMERIC,   -- 분당 골드 (gold_earned / 분)
  dpm                         NUMERIC,   -- 분당 챔피언 피해 (damage_to_champions / 분)
  damage_taken_per_min        NUMERIC,   -- 분당 받은 피해 (damage_taken / 분)
  cc_time_per_min             NUMERIC,   -- 분당 CC 시간 (cc_time / 분)
  exp_per_min                 NUMERIC,   -- 분당 경험치 (exp / 분)
  damage_to_turrets_per_min   NUMERIC,   -- 분당 건물 피해 (damage_to_turrets / 분)
  cs_per_min                  NUMERIC,   -- 분당 CS (minions+neutral / 분)
  wards_placed_per_min        NUMERIC,   -- 분당 와드 설치 (wards_placed / 분)
  wards_killed_per_min        NUMERIC,   -- 분당 와드 파괴 (wards_killed / 분)
  kda                         NUMERIC,   -- (킬+어시) / 데스(0이면 1)
  damage_taken_per_death      NUMERIC,   -- 데스당 받은 피해 (damage_taken / deaths_safe)
  damage_dealt_per_death      NUMERIC,   -- 데스당 가한 챔피언 피해 (damage_to_champions / deaths_safe)
  dead_time_pct               NUMERIC,   -- 사망 시간 비율(%) (time_spent_dead / (분*60) * 100)
  lane_gold_diff              NUMERIC,   -- 동일 포지션 상대와의 골드 차 (gold_earned - 상대 평균)
  -- ── 파이프라인 (정의서엔 없음, 우리 운영용) ──────────────────────
  is_mmr_eligible             BOOLEAN      NOT NULL DEFAULT TRUE,   -- MMR 계산 적격 여부 (step03 §3 판정)
  is_deleted                  BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  create_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- 적재 시각
  update_date                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),  -- 수정 시각
  CONSTRAINT uq_mmr_participant_metric_match_puuid UNIQUE (custom_match_id, puuid)  -- 경기·유저 1행
);

CREATE INDEX IF NOT EXISTS idx_mpm_guild_season_played
  ON mmr_participant_metric (guild_id, season, played_date DESC);
CREATE INDEX IF NOT EXISTS idx_mpm_custom_match
  ON mmr_participant_metric (custom_match_id);
CREATE INDEX IF NOT EXISTS idx_mpm_puuid_season
  ON mmr_participant_metric (puuid, season);
```

> **UNIQUE는 `(custom_match_id, puuid)`.** 한 경기·한 유저 → metric 1개. (`match_participant_id`는 컬럼에서 제외 — raw_data만으로 backfill 가능하게 자연키 사용. interface payload가 필요로 하면 전송 시 join으로 해결, [step08 §5](./step08_incremental_worker.md).)
> **raw/파생은 NULL 허용**(누락 키·구포맷 대응). 식별·변환 categoricals와 파이프라인 플래그만 NOT NULL.
> **생성 범위**: **모든 길드** 경기에 생성(step03). MMR 계산 게이트(`mmr_match_queue`)만 구독 길드. 기존 경기는 일회성 **backfill SQL**([backfill_match_participant_metric.sql](../backfill_match_participant_metric.sql))로 적재.

### 3.7 mmr_match_result

```sql
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
```

> `UNIQUE(calculation_id, match_participant_id)`가 멱등 upsert 키([03_api_contract.md §10](../03_api_contract.md)). 같은 calculation_id 재호출 시 중복 INSERT 대신 갱신.

### 3.8 mmr_history ⭐ partitioned

```sql
CREATE TABLE IF NOT EXISTS mmr_history (
  id                      BIGSERIAL,
  guild_id                VARCHAR(128) NOT NULL,
  season                  VARCHAR(32)  NOT NULL,
  puuid                   VARCHAR(128) NOT NULL,
  custom_match_id         VARCHAR(255) NOT NULL,   -- 항상 경기 단위 기록
  position                VARCHAR(8)   NOT NULL,
  mmr_delta               INTEGER      NOT NULL,
  before_mmr              INTEGER      NOT NULL,
  after_mmr               INTEGER      NOT NULL,
  before_pos_mmr          INTEGER      NOT NULL,
  after_pos_mmr           INTEGER      NOT NULL,
  mmr_match_result_id     BIGINT       NOT NULL,   -- → mmr_match_result.id (산식 상세 조인, FK 제약은 안 검)
  is_deleted              BOOLEAN      NOT NULL DEFAULT FALSE,  -- 리플 삭제 시 soft delete
  create_date             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, create_date)                    -- partition key 포함 필수
) PARTITION BY RANGE (create_date);
```

**초기 파티션 + per-partition 인덱스** (운영 시작 시점 기준 6개월치 선생성):

```sql
-- 예: 2026-05 ~ 2026-10
CREATE TABLE IF NOT EXISTS mmr_history_202605 PARTITION OF mmr_history
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- ... 202606 ~ 202610 동일 패턴 ...

CREATE INDEX IF NOT EXISTS idx_mmr_history_202605_guild_season_puuid_create
  ON mmr_history_202605 (guild_id, season, puuid, create_date DESC);
-- ... 각 파티션마다 동일 ...
```

> **history는 항상 경기 단위**라 `history_type`·`reason` 컬럼을 두지 않는다. RECALC(구독/재구독) 시 길드+시즌 history를 통째로 wipe 후 재생성.
> `mmr_match_result_id`(NOT NULL)로 산식 상세에 1:1 연결. **삭제 롤백**은 이 row의 `mmr_delta` + result 조인(`game_result`)으로 summary 역산([step14](./step14_deletion_rollback.md)).
> 다음달 파티션 자동 생성은 [step12 monthly cron](./step12_crons.md).

### 3.9 mmr_member_summary

```sql
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
  is_deleted        BOOLEAN      NOT NULL DEFAULT FALSE,   -- 구독 해지 시 리더보드 숨김 (cleanup은 status='cancelled' 기준, 유예 없음)
  update_date       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, season, puuid)
);

CREATE INDEX IF NOT EXISTS idx_mmr_member_summary_leaderboard
  ON mmr_member_summary (guild_id, season, total_mmr DESC)
  WHERE is_deleted = FALSE;
```

> **포지션 MMR 초기값은 앱 config(현재 1300, 변경 여지) — DB default 아님.** 앱이 summary 생성 시 초기값을 세팅한다(RECALC 초기화·신규 유저). 단, `total_mmr` = Σ(pos_mmr × pos_games) / Σ(pos_games)로 **games>0인 포지션만** 가중평균([02_data_model.md §2.9](../02_data_model.md)). games=0 포지션의 초기값은 평균에서 제외되므로 초기 total_mmr도 그 초기값. `overall_winrate`는 저장 안 함(`total_wins/total_games`로 즉시 계산).

---

## 4. 결정사항 (이 step에서 확정)

| 항목 | 결정 | 근거 |
|---|---|---|
| 테이블명 | `docs/mmr/` 신규명 사용 (`mmr_guild_state` 등) | SoT = docs/mmr/ |
| `recalc_flag` | **두지 않음** | 삭제는 역산 롤백, RECALC 없음. RECALC는 구독/재구독만 |
| 삭제 롤백 시 `game_result` | history에 중복 저장 안 함 | `mmr_match_result_id` 조인으로 얻음 |
| `last_job_id` / `last_calculation_id` / `initialized_date` | **두지 않음** | 컬럼 검토에서 제거. job·calc 추적은 `mmr_job`로 충분 |
| metric UNIQUE | `(custom_match_id, puuid)` 자연키 | 경기·유저당 metric 1개. raw_data만으로 backfill 가능(`match_participant_id` 미보유) |
| metric 생성 범위 | **모든 길드** (MMR 계산만 구독) | 구독/재구독 RECALC가 raw 재파싱 backfill 불필요 |
| `mmr_history`: `history_type`·`reason` 제거, `mmr_match_result_id` 참조 | 항상 경기 단위 기록 → 이벤트 타입 불필요. 산식 상세는 result.id로 1:1 조인 |
| MMR 테이블 상호 FK | 걸지 않음 | 파티션·대량삭제·재구독 복구 유연성 |

---

## 5. 완료 기준 (DoD)

- [ ] 마이그레이션 1회 실행 시 9종 테이블 + 인덱스 + 6개월치 파티션 생성
- [ ] 재실행해도 에러 없음 (`IF NOT EXISTS` 멱등)
- [ ] `mmr_guild_state`에 `recalc_flag` 없음 / `mmr_history`에 `game_result` 컬럼 없음(조인) / 4개 테이블에 `is_deleted` 있음
- [ ] `mmr_season_baseline` partial unique (시즌당 active 1개) 동작 — 같은 시즌 active 2개 INSERT 시 위반
- [ ] `mmr_match_result` 같은 `(calculation_id, match_participant_id)` 중복 INSERT 시 위반
- [ ] `mmr_history`에 `create_date` 범위 밖 INSERT 시 파티션 없음 에러(=파티션 경계 정상)
- [ ] 통계 테이블(`match_participant` 등) 무변경

---

## 6. 의존성 / 다음 step

- **선행**: 없음 (기존 `guild`, `custom_match`, `match_participant` 테이블 존재 전제)
- **후행**: [step02_schema.md](./step02_schema.md) — 이 DDL을 Drizzle ORM으로 1:1 매핑
</content>
</invoke>
