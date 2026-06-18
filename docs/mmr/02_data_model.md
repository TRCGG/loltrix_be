# MMR 데이터 모델

> 짝 문서: [00_overview.md](./00_overview.md) | [01_architecture.md](./01_architecture.md) | [03_api_contract.md](./03_api_contract.md)

---

## 1. 테이블 목록

| 테이블 | 역할 | 비고 |
|---|---|---|
| `guild_subscription` | 길드별 MMR 구독 상태 | |
| `mmr_guild_state` | 길드+시즌별 MMR 계산 진행 상태 | recalc_flag 없음 (RECALC는 (재)구독만) |
| `mmr_season_baseline` | 시즌별 전체 길드 통합 baseline | `guild_id` 없음 |
| `mmr_job` | 비동기 작업 큐 | 유지 확정. `INCREMENTAL_BATCH`/`RECALC`/`CLEANUP` (BASELINE은 동기 admin API) |
| `mmr_match_queue` | 경기별 MMR 처리 상태/큐 | `create_date` 기준 1시간 딜레이(config) |
| `mmr_participant_metric` | 정제 참가자 데이터(통계/상대전적/MMR 공통) | **마이그레이션 007 소유**(상대전적이 먼저 생성). 모든 길드 생성, MMR 계산은 구독 길드만 |
| `mmr_match_result` | 경기별 MMR 계산 결과 | |
| `mmr_history` | MMR 변동 시계열 | monthly range partition |
| `mmr_member_summary` | 유저별 현재 MMR (SoT) | incremental 전제 상태 |

---

## 2. 테이블 상세

### 2.1 `guild_subscription`

길드의 **MMR 구독 여부(권한/결제)** 를 관리한다. 길드 1개 = 1행이며 **시즌과 무관**하다(구독 1건이 여러 시즌에 걸침). "구독했나"만 답하고, 시즌별 계산 진행 상태는 `mmr_guild_state`가 따로 본다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | serial | PK | 단일 surrogate PK (FK 참조 없음 → uuid 불필요) |
| `guild_id` | varchar(128) | FK → guild.id | |
| `service_key` | varchar(32) | | 현재 `'MMR'` 고정. 미래 구독 서비스 확장 포인트 |
| `status` | varchar(16) | | `active` / `cancelled` |
| `enabled_date` | timestamptz | | **현재(최근) 활성화 시각** (재구독 시 갱신) |
| `ended_date` | timestamptz | nullable | 최근 해지 시각(이력용). cleanup은 `status='cancelled'` 기준 — 유예 없음 |
| `create_date` | timestamptz | | **최초 구독 생성 시각** (불변) |
| `update_date` | timestamptz | | |

**제약**: `UNIQUE(guild_id, service_key)`

---

### 2.2 `mmr_guild_state`

**길드 × 시즌** 단위의 MMR **계산 진행 상태**를 추적한다(시즌마다 1행). `guild_subscription`이 "구독했나(결제/권한)"를 본다면, 이쪽은 "이 시즌 계산이 어디까지 됐나(`wait_init`→`ready`)"를 본다. 결제와 무관한 운영 상태라 구독 테이블과 분리한다. (동시성은 이 행 잠금이 아니라 `mmr_job` 큐가 담당 — [01_architecture.md §E](./01_architecture.md))

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | serial | PK | 단일 surrogate PK (FK 참조 없음 → uuid 불필요) |
| `guild_id` | varchar(128) | | |
| `season` | varchar(32) | | 예: `'2026'` |
| `status` | varchar(16) | | `wait_init` / `ready` / `error` |
| `error_message` | text | nullable | status=error 시 사유 |
| `create_date` | timestamptz | | |
| `update_date` | timestamptz | | |

**제약**: `UNIQUE(guild_id, season)`

> RECALC는 **구독·재구독 시에만** 발생한다(삭제는 역산 롤백, RECALC 없음). 따라서 `recalc_flag` 컬럼은 두지 않는다.

**상태 전이**:
```
(구독/재구독) ──▶ wait_init ──[RECALC 완료]──▶ ready
                    │                            │
                 [실패]                [incremental 반복]
                    ▼
                  error ──[재시도]──▶ wait_init
```

---

### 2.3 `mmr_season_baseline`

시즌별 전체 길드 통합 baseline. **guild_id 없음** — 모든 길드가 동일 시즌 baseline 공유.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | serial | PK | uuid→serial |
| `season` | varchar(32) | | |
| `baseline_version` | varchar(32) | | 예: `'2026-06'` |
| `mmr_baseline` | jsonb | | `{ f1_mean, f2_mean }` |
| `game_impact_baseline` | jsonb | | `{ position_weights, outcome_stats }` |
| `metadata` | jsonb | | `{ match_count, row_count }` (운영 표시용) |
| `is_active` | boolean | default false | 시즌당 active 1개만 허용 |
| `create_date` | timestamptz | | 행 생성 = 계산 반영 시각 |
| `update_date` | timestamptz | | `is_active` 전환 추적 |

**제약**:
- `UNIQUE(season, baseline_version)`
- `UNIQUE(season) WHERE is_active = true` (partial unique — active baseline 시즌당 1개)

---

### 2.4 `mmr_job`

비동기 작업 큐. `INCREMENTAL_BATCH` / `RECALC` / `CLEANUP` 작업을 추적한다. (step05에서 **유지 확정**. 동시성 단일화의 핵심 — [01_architecture.md §E](./01_architecture.md))

> **BASELINE은 큐에 넣지 않는다.** 관리자 수동 + <60초라 동기 admin API로 처리 → job_type에서 제외.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | serial | PK | uuid→serial |
| `guild_id` | varchar(128) | nullable | INCREMENTAL_BATCH/RECALC 필수, CLEANUP은 null |
| `season` | varchar(32) | nullable | 동상 |
| `job_type` | varchar(32) | | `INCREMENTAL_BATCH` / `RECALC` / `CLEANUP` |
| `status` | varchar(16) | | `wait` / `run` / `done` / `fail` / `cancel` |
| `attempts` | int | default 0 | 현재 재시도 횟수. 상한은 config `MMR_JOB_MAX_ATTEMPTS`(=3) |
| `scheduled_date` | timestamptz | | 실행 예약 시각 (재시도·daily cron 예약) |
| `started_date` | timestamptz | nullable | 픽업 시각 |
| `finished_date` | timestamptz | nullable | 종료 시각 |
| `error_message` | text | nullable | 실패 사유 |
| `create_date` | timestamptz | | |
| `update_date` | timestamptz | | |

**인덱스**:
- `(status, scheduled_date) WHERE status IN ('wait', 'run')`
- `(guild_id, job_type, status)`

---

### 2.5 `mmr_match_queue`

경기 한 건의 MMR 처리 상태. `create_date`를 기준으로 1시간(config `MMR_PROCESS_DELAY_MINUTES`=60) 경과 여부를 판단한다.

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `custom_match_id` | varchar(255) | PK, FK → custom_match.id | |
| `guild_id` | varchar(128) | | |
| `season` | varchar(32) | | |
| `status` | varchar(16) | | `wait` / `done` / `fail` / `skip` |
| `error_message` | text | nullable | status=fail 사유 |
| `is_deleted` | boolean | default false | 리플 삭제 시 soft delete |
| `create_date` | timestamptz | | **처리 딜레이(기본 60분) 기준 컬럼** |
| `update_date` | timestamptz | | 마지막 상태 변경 (done/skip/fail 시각 포함) |

> 처리한 `calculation_id`·`baseline_version`은 `mmr_match_result`에 있으므로 여기 중복 보관하지 않는다(제어 테이블은 상태만).

**Worker 쿼리 패턴**:
```sql
SELECT guild_id FROM mmr_match_queue
WHERE status = 'wait' AND is_deleted = false
  AND create_date <= NOW() - INTERVAL '60 minutes'   -- MMR_PROCESS_DELAY_MINUTES
GROUP BY guild_id
```

**상태 전이**:
```
(생성) ──▶ wait ──[1시간 경과 + worker 처리]──▶ done
             │
             ├─[is_mmr_eligible=false]──▶ skip
             └─[처리 실패]──────────────▶ fail
```

> **경기 삭제는 `status`가 아니라 `is_deleted=true`** — status와 직교. 삭제된 경기는 status 무관하게 `is_deleted=false` 필터로 제외([step14](./steps/step14_deletion_rollback.md)).

**인덱스**: `(guild_id, season, status, create_date)`

---

### 2.6 `mmr_participant_metric`

정제된 참가자 데이터(통계/MMR 공통 입력). **모든 길드 경기에 생성**한다 — 단, MMR 계산(`mmr_match_queue`·worker)은 **구독 길드만** 대상.
- 신규 업로드 시: 업로드 handler에서 즉시 생성 (구독 여부 무관)
- 기존 경기: 일회성 **backfill SQL**([backfill_match_participant_metric.sql](backfill_match_participant_metric.sql))로 `replay.raw_data`에서 적재

> 구조는 MMR 팀 [정의서](match_participant_metric_table_spec.md)(**raw 49 + 파생 14**) 기반. 단 categoricals는 **변환값**으로 저장(`game_team=blue/red`, `position=TOP/JUG/…`, `game_result=1/0`)해 전송 시 리네임만 남긴다([03 §3](03_api_contract.md)).
> 모든 길드에 metric을 미리 쌓아두므로, 구독/재구독 RECALC 시 raw_data 재파싱 backfill이 불필요하다(이미 적재됨).

**식별 / 메타**

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | bigserial | PK | |
| `custom_match_id` | varchar(255) | NOT NULL | = `replay.replay_code` |
| `puuid` | varchar(128) | NOT NULL | |
| `player_code` | varchar(64) | NULL | 상대전적 본계정 병합 식별자. **MMR은 미사용**(puuid 기반, [00 §9](00_overview.md)) |
| `guild_id` | varchar(128) | NOT NULL | |
| `season` | varchar(32) | NOT NULL | |
| `champion_id` | varchar(16) | NULL | SKIN→champion 매핑 실패 시 NULL |
| `game_team` | varchar(8) | NOT NULL | 변환값 `blue`/`red` (TEAM 100/200) |
| `position` | varchar(8) | NOT NULL | 변환값 `TOP`/`JUG`/`MID`/`ADC`/`SUP` |
| `game_result` | smallint | NOT NULL | 변환값 `1`(승)/`0`(패) (WIN='Win'→1) |
| `played_date` | timestamptz | NOT NULL | 경기 플레이 시각. raw에 없어 업로드 시각 fallback. incremental 순서(ASC) 기준 |

**raw 49 / 파생 14** (정의서 §2.2·§2.3): `kills`·`deaths`·`assists`·`gold_earned`·`cc_time`·`game_duration`·`damage_to_champions`·`damage_taken`·`wards_placed`… (raw, nullable INTEGER) + `gold_per_min`·`dpm`·`cs_per_min`·`kda`·`lane_gold_diff`… (파생, nullable NUMERIC, 소수 2자리). 전체 목록·JSON 키·산식은 [정의서](match_participant_metric_table_spec.md)와 [backfill SQL](backfill_match_participant_metric.sql)이 canonical.

**파이프라인** (정의서엔 없음, 우리 운영용)

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `is_mmr_eligible` | boolean | default true | false면 해당 경기 전체 MMR 제외 |
| `is_deleted` | boolean | default false | 리플 삭제 시 soft delete |
| `create_date` | timestamptz | | |
| `update_date` | timestamptz | | |

**제약**: `UNIQUE(custom_match_id, puuid)` — `match_participant_id`는 미보유(raw_data 파싱 기반 자연키). 전송 payload의 `match_participant_id`는 `match_participant` join으로 채움([step08 §5](steps/step08_incremental_worker.md)).

**is_mmr_eligible = false 판정 기준 (v1)**:
1. `time_played < 300` (5분 미만)
2. **15분 미만 항복** — `GAME_ENDED_IN_SURRENDER='1'` AND `time_played < 900`. 15분 이후 항복·정상 종료는 무관
3. `total_damage_champions = 0` AND `kill + assist = 0` (AFK 의심)
4. **비정상 포지션 구조** — 경기가 5포지션(TOP/JUG/MID/ADC/SUP) 각 2명 정상 구조가 아니면 경기 전체 제외
5. 운영자 수동 제외

> 경기 내 1명이라도 false면 해당 `custom_match` 전체 `mmr_match_queue = skip`

**인덱스**:
- `(guild_id, season, played_date DESC)`
- `(custom_match_id)`
- `(puuid, season)`
- `(guild_id, player_code)` — 상대전적 H2H 셀프 조인용 (MMR 미사용)

---

### 2.7 `mmr_match_result`

경기 한 건의 **계산 상세 결과표**(영수증). 참가자별로 `expected_score`·`actual_score`·`*_factor`·`pre/post_game_mmr` 등 **산식의 중간값까지** 담아 "이 경기 MMR이 왜 이렇게 변했나(WHY)"를 설명·재현·감사한다. **경기 계산만** 기록하며 `(calculation_id, match_participant_id)`로 멱등 upsert. incremental / RECALC 모두 여기에 저장. (시간순 변동 로그는 `mmr_history`가 따로 담는다.)

| 컬럼 | 타입 | 제약 | 설명 |
|---|---|---|---|
| `id` | bigserial | PK | |
| `calculation_id` | varchar(64) | | |
| `baseline_version` | varchar(32) | | |
| `guild_id` | varchar(128) | | |
| `season` | varchar(32) | | |
| `custom_match_id` | varchar(255) | | |
| `match_participant_id` | int | | |
| `puuid` | varchar(128) | | |
| `position` | varchar(8) | | |
| `game_result` | smallint | | |
| `pre_game_mmr` | int | | 경기 전 포지션 MMR |
| `mmr_change` | int | | 변동량 (양수/음수) |
| `post_game_mmr` | int | | 경기 후 포지션 MMR |
| `expected_score` | numeric(6,4) | | ELO 기대 점수 |
| `actual_score` | numeric(6,4) | | 실제 기여도 점수 |
| `relative_factor` | numeric(6,4) | | |
| `personal_factor` | numeric(6,4) | | |
| `final_factor` | numeric(6,4) | | |
| `is_deleted` | boolean | default false | 리플 삭제 시 soft delete |
| `calculated_date` | timestamptz | | |

**제약**: `UNIQUE(calculation_id, match_participant_id)` — 멱등 upsert 보장

**인덱스**:
- `(guild_id, season, puuid, calculated_date DESC)`
- `(custom_match_id)`

---

### 2.8 `mmr_history` ⭐ partitioned

유저별 MMR 변동 **시계열 로그**(통장 거래내역). "언제 얼마씩 움직였나"를 시간순으로 쌓아 변동 그래프·이력 화면의 소스가 된다. **항상 경기 단위 기록**이며(비-경기 이벤트 없음 → `history_type` 불필요), RECALC 시 길드+시즌 history를 통째로 wipe 후 재생성해 **항상 현재 타임라인**을 반영한다. `create_date` 기준 monthly range partition. 각 row는 `mmr_match_result_id`로 그 변동의 산식 상세(`mmr_match_result`)에 1:1 연결된다.

> **삭제 롤백 소스**: 리플 삭제 시 이 테이블의 해당 경기 row(현재 적용된 `mmr_delta`)와, `mmr_match_result_id`로 조인한 `mmr_match_result.game_result`로 `mmr_member_summary`를 역산한다([01 §2-C](./01_architecture.md), [step14](./steps/step14_deletion_rollback.md)). `game_result`는 history에 중복 저장하지 않고 result 조인으로 얻는다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | bigserial | PK 일부 (partitioned table 요구) |
| `guild_id` | varchar(128) | |
| `season` | varchar(32) | |
| `puuid` | varchar(128) | |
| `custom_match_id` | varchar(255) | |
| `position` | varchar(8) | |
| `mmr_delta` | int | 변동량 (이력 표시 + **롤백 시 pos_mmr 역산**) |
| `before_mmr` | int | 변동 전 total MMR |
| `after_mmr` | int | 변동 후 total MMR |
| `before_pos_mmr` | int | 변동 전 포지션 MMR |
| `after_pos_mmr` | int | 변동 후 포지션 MMR |
| `mmr_match_result_id` | bigint | → `mmr_match_result.id` (산식 상세 조인). NOT NULL |
| `is_deleted` | boolean | 리플 삭제 시 soft delete (default false) |
| `create_date` | timestamptz | **partition key** |

**PK**: `(id, create_date)`

**파티션 전략**:
```sql
CREATE TABLE mmr_history (...) PARTITION BY RANGE (create_date);

CREATE TABLE mmr_history_2026_01 PARTITION OF mmr_history
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

-- daily cron이 매월 1일에 다음달 파티션 미리 생성
```

**인덱스** (파티션별):
- `(guild_id, season, puuid, create_date DESC)`

**이력 조회 패턴** (유저별 MMR 변동 그래프 등):
```sql
SELECT puuid, mmr_delta, before_pos_mmr, after_pos_mmr, create_date
FROM mmr_history
WHERE guild_id = $1 AND season = $2 AND puuid = $3
  AND is_deleted = false
ORDER BY create_date DESC
```

---

### 2.9 `mmr_member_summary`

유저별 현재 MMR의 **진실의 원천(SoT)**. incremental worker가 매 경기 후 갱신하고, 다음 경기의 `pre_match_user_summary`로 사용한다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `guild_id` | varchar(128) | PK 일부 |
| `season` | varchar(32) | PK 일부 |
| `puuid` | varchar(128) | PK 일부 |
| `total_mmr` | int | 포지션별 가중 평균 MMR |
| `total_games` | int | |
| `total_wins` | int | |
| `top_mmr` | int | |
| `top_games` | int | |
| `top_wins` | int | |
| `jug_mmr` | int | |
| `jug_games` | int | |
| `jug_wins` | int | |
| `mid_mmr` | int | |
| `mid_games` | int | |
| `mid_wins` | int | |
| `adc_mmr` | int | |
| `adc_games` | int | |
| `adc_wins` | int | |
| `sup_mmr` | int | |
| `sup_games` | int | |
| `sup_wins` | int | |
| `is_deleted` | boolean | default false — 구독 해지 soft delete |
| `update_date` | timestamptz | |

**PK**: `(guild_id, season, puuid)`

**`total_mmr` 계산**:
```
total_mmr = Σ(pos_mmr × pos_games) / Σ(pos_games)
            (플레이한 포지션만 포함)
초기값: 앱 config(현재 1300, 변경 여지 — DB default 아님). 게임 없는 포지션은 계산에서 제외
```

**`overall_winrate`는 저장하지 않는다** — `total_wins / total_games`로 즉시 계산.

**인덱스**:
- `(guild_id, season, total_mmr DESC) WHERE is_deleted = false`

---

## 3. 테이블 간 관계

```
guild ─────────────────────────────────────┐
  │                                        │
  ├─▶ guild_subscription                   │
  │                                        │
  └─▶ mmr_guild_state (guild_id, season)  │
                                           │
custom_match ──────────────────────────────┤
  │                                        │
  ├─▶ mmr_match_queue                     │
  │                                        │
  └─▶ match_participant                   │
            │                             │
            └─▶ mmr_participant_metric    │
                        │                 │
                        ▼                 │
              mmr_match_result  ◀─────────┤
              mmr_history       ◀─────────┤
              mmr_member_summary ◀────────┘

mmr_season_baseline (season 단위, guild 무관)
mmr_job             (비동기 작업 추적)
```

---

## 4. 인덱스 전략 요약

```sql
-- mmr_guild_state
CREATE UNIQUE INDEX ON mmr_guild_state (guild_id, season);

-- mmr_season_baseline
CREATE UNIQUE INDEX ON mmr_season_baseline (season, baseline_version);
CREATE UNIQUE INDEX ON mmr_season_baseline (season) WHERE is_active = true;

-- mmr_job
CREATE INDEX ON mmr_job (status, scheduled_date) WHERE status IN ('wait', 'run');
CREATE INDEX ON mmr_job (guild_id, job_type, status);

-- mmr_match_queue
CREATE INDEX ON mmr_match_queue (guild_id, season, status, create_date);

-- mmr_participant_metric (마이그레이션 007 소유)
CREATE UNIQUE INDEX ON mmr_participant_metric (custom_match_id, puuid);
CREATE INDEX ON mmr_participant_metric (guild_id, season, played_date DESC);
CREATE INDEX ON mmr_participant_metric (custom_match_id);
CREATE INDEX ON mmr_participant_metric (puuid, season);
CREATE INDEX ON mmr_participant_metric (guild_id, player_code);  -- 상대전적 H2H (MMR 미사용)

-- mmr_match_result
CREATE UNIQUE INDEX ON mmr_match_result (calculation_id, match_participant_id);
CREATE INDEX ON mmr_match_result (guild_id, season, puuid, calculated_date DESC);
CREATE INDEX ON mmr_match_result (custom_match_id);

-- mmr_history (파티션별)
CREATE INDEX ON mmr_history_YYYYMM (guild_id, season, puuid, create_date DESC);

-- mmr_member_summary
CREATE INDEX ON mmr_member_summary (guild_id, season, total_mmr DESC)
  WHERE is_deleted = false;
```

---

## 5. soft delete — 두 가지 트리거

soft delete(`is_deleted`) 후 daily cron `CLEANUP`이 hard delete한다([step12](./steps/step12_crons.md)). 트리거가 둘이고, **유예 정책이 다르다**: 구독 해지는 **유예 없음**(다음 CLEANUP에 정리), 리플 삭제는 **30일 유예**.

### 5.1 구독 해지 시 (길드 단위) — 유예 없음

```
mmr_member_summary.is_deleted = true (해지 즉시 숨김), 다음 CLEANUP이 hard delete (유예 없음):
  ✓ mmr_member_summary / mmr_match_result / mmr_history / mmr_match_queue  (그 길드 전체)

hard delete 안 함:
  ✗ mmr_participant_metric  (모든 길드 보존 — 재구독 RECALC 재활용)
  ✗ guild_subscription / mmr_season_baseline / mmr_guild_state  (이력·공유 데이터)
```

> 유예를 두지 않는 이유: metric이 전 길드 보존되고 재구독은 항상 RECALC로 복원하므로, summary/result/history를 30일 보관해도 재구독 시 어차피 wipe 후 재생성된다 → 보관 이점이 없음.

### 5.2 리플 삭제 / 경기 제외 시 (경기 단위) → [step14](./steps/step14_deletion_rollback.md)

```
그 경기의 행만 is_deleted = true, 30일 후 hard delete:
  ✓ mmr_participant_metric / mmr_match_queue / mmr_match_result / mmr_history  (해당 custom_match_id)
  · mmr_member_summary 는 soft delete 아님 → 역산 롤백으로 점수만 되돌림
```

> 구독 해지는 metric을 보존하지만, 리플 삭제는 그 경기 metric도 `is_deleted=true`(경기 자체가 사라지므로).
