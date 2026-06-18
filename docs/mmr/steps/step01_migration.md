# step01 — DB 마이그레이션 (SQL DDL)

> 상위 문서: [00_overview.md](../00_overview.md) | [02_data_model.md](../02_data_model.md)
> 다음 step: [step02_schema.md](./step02_schema.md)
>
> **이 문서의 테이블명·컬럼명이 구현의 기준(SoT)이다.** 기존 코드가 다른 이름을 쓰면 코드가 잘못된 것이며, 설계 확정 후 코드를 이 문서에 맞춘다.

---

## 1. 목적 / 범위

MMR 시스템 **전용 테이블 8종**을 한 번의 마이그레이션으로 생성한다. (`mmr_participant_metric`은 상대전적이 먼저 만든 공유 테이블 — 마이그레이션 007 소유, 여기선 만들지 않는다)

- 통계 도메인(`replay`, `custom_match`, `match_participant`)은 **건드리지 않는다**. MMR은 그 위에 얹는다.
- `mmr_history`는 처음부터 **monthly RANGE partition**으로 만든다 (나중에 쪼개기 어려움 — [00_overview.md §8](../00_overview.md)).
- 이 step은 **DDL만** 책임진다. ORM 매핑은 [step02](./step02_schema.md), 데이터 로직은 step03+.

### 산출물

| 파일 | 내용 |
|---|---|
| `migrations/008_add_mmr_system.sql` | 아래 §3 DDL (MMR 전용 8종) |

> dev에 이미 005(encounter 인덱스)·006(player_code 시퀀스)·007(`mmr_participant_metric`)이 있으므로 **`008_add_mmr_system.sql`** 로 신규 작성한다. `mmr_participant_metric`은 **007이 소유(상대전적)** 하므로 008에서 제외한다.

---

## 2. 테이블 8종 (생성 순서 = FK 의존 순서)

| # | 테이블 | FK 의존 | 비고 |
|---|---|---|---|
| 1 | `guild_subscription` | `guild` | 구독 게이트 |
| 2 | `mmr_guild_state` | — | 계산 진행 상태 (recalc_flag 없음) |
| 3 | `mmr_season_baseline` | — | `guild_id` 없음 (시즌 공유) |
| 4 | `mmr_job` | — | 비동기 작업 큐 (step05에서 유지 확정) |
| 5 | `mmr_match_queue` | `custom_match` | 경기별 처리 상태, 처리 딜레이(기본 60분) 기준 `create_date` |
| 6 | `mmr_match_result` | — | 멱등 upsert 키 보유 |
| 7 | `mmr_history` | — | **partitioned** |
| 8 | `mmr_member_summary` | — | 유저별 현재 MMR (SoT) |

> `mmr_participant_metric`은 **마이그레이션 007(상대전적)이 소유**하는 공유 테이블이라 이 8종에서 제외. 모든 길드 생성·자연키 `(custom_match_id, puuid)`는 [02 §2.6](../02_data_model.md) 참고.

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

### 3.6 mmr_match_result

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

### 3.7 mmr_history ⭐ partitioned

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

### 3.8 mmr_member_summary

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

- [ ] 마이그레이션 1회 실행 시 MMR 전용 8종 테이블 + 인덱스 + 6개월치 파티션 생성 (`mmr_participant_metric`은 007이 이미 생성)
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
