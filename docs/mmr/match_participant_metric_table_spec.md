# match_participant_metric 테이블 정의서 (백엔드 적재용)

> **목적**: MMR 계산 입력이 되는 경기 참가자별 스탯 테이블 정의. 현재는 MMR 레포의 SQL 마이그레이션(`migrations/004`, `006`)으로 생성하지만, **운영에서는 백엔드가 리플레이 적재 시 이 구조로 저장**한다.
> **단위**: 한 row = 한 경기의 한 참가자(player-game). 한 경기 = 정확히 10 row.
> **출처**: raw 지표는 `replay.raw_data`(JSONB 배열) 파싱, 파생지표는 raw에서 계산.

---

## 1. 테이블 개요

| 항목 | 값 |
|---|---|
| 테이블명 | `match_participant_metric` |
| 1 row 단위 | 경기 참가자 1명 (player-game) |
| 적재 시점 | 리플레이 업로드 → raw_data 파싱 시 |
| 파생지표 | 적재 시 raw에서 계산해 같은 row에 저장 |
| 성격 | MMR 적용 참가자 메트릭 테이블 (raw + 파생 동시 보관) |

> raw 지표만 필요하면 파생 컬럼은 생략 가능하나, **검수·재현·디버깅을 위해 파생까지 함께 저장**하는 것을 권장한다(현재 MMR 파이프라인은 raw에서 매번 재계산함).

---

## 2. 컬럼 정의

### 2.1 식별 / 메타

| 컬럼 | 타입 | NULL | 설명 |
|---|---|---|---|
| `id` | BIGSERIAL | NOT NULL | PK |
| `replay_code` | VARCHAR(128) | NOT NULL | 경기 식별자 (`league/replay.game_id`) |
| `puuid` | VARCHAR(64) | NOT NULL | 유저 식별자 |
| `guild_id` | VARCHAR(64) | NULL | 길드 |
| `champion_id` | VARCHAR(16) | NULL | 챔피언 id (`SKIN` → Champion 테이블 매핑) |
| `team` | VARCHAR(8) | NULL | 팀 (raw `TEAM`) |
| `position` | VARCHAR(16) | NULL | 포지션 — 라이엇 원본값 `TOP`/`JUNGLE`/`MIDDLE`/`BOTTOM`/`UTILITY` |
| `win` | BOOLEAN | NULL | 승패 (`WIN = 'Win'` → true) |
| `played_date` | TIMESTAMP | NULL | 경기 플레이 시각 (MMR 누적 순서 기준) |
| `create_date` | TIMESTAMP | NOT NULL | 적재 시각 (default now) |

> **포지션 표기 주의**: 이 테이블은 라이엇 원본값(`JUNGLE/MIDDLE/BOTTOM/UTILITY`)을 저장한다. MMR 계약(`interface_spec.md`)의 enum(`JUG/MID/ADC/SUP`)으로의 변환은 MMR 서비스 전달 직전에 수행한다.

### 2.2 raw 지표 (replay.raw_data JSON 파싱)

| 컬럼 | 타입 | JSON 키 | 설명 |
|---|---|---|---|
| `kills` | INTEGER | `CHAMPIONS_KILLED` | 킬 |
| `deaths` | INTEGER | `NUM_DEATHS` | 데스 |
| `assists` | INTEGER | `ASSISTS` | 어시스트 |
| `double_kills` | INTEGER | `DOUBLE_KILLS` | |
| `triple_kills` | INTEGER | `TRIPLE_KILLS` | |
| `quadra_kills` | INTEGER | `QUADRA_KILLS` | |
| `penta_kills` | INTEGER | `PENTA_KILLS` | |
| `killing_sprees` | INTEGER | `KILLING_SPREES` | |
| `largest_killing_spree` | INTEGER | `LARGEST_KILLING_SPREE` | |
| `gold_earned` | INTEGER | `GOLD_EARNED` | 획득 골드 |
| `cc_time` | INTEGER | `TIME_CCING_OTHERS` | CC 기여 시간(초) |
| `game_duration` | INTEGER | `TIME_PLAYED` | **경기 시간(초 단위)** |
| `damage_to_champions` | INTEGER | `TOTAL_DAMAGE_DEALT_TO_CHAMPIONS` | 챔피언 대상 피해 |
| `damage_taken` | INTEGER | `TOTAL_DAMAGE_TAKEN` | 받은 피해 |
| `damage_self_mitigated` | INTEGER | `TOTAL_DAMAGE_SELF_MITIGATED` | 경감 피해 |
| `vision_score` | INTEGER | `VISION_SCORE` | 시야 점수 |
| `wards_placed` | INTEGER | `WARD_PLACED` | 설치 와드 |
| `wards_killed` | INTEGER | `WARD_KILLED` | 파괴 와드 |
| `detector_wards_placed` | INTEGER | `WARD_PLACED_DETECTOR` | 핑크와드 설치 |
| `control_wards_bought` | INTEGER | `VISION_WARDS_BOUGHT_IN_GAME` | 제어와드 구매 |
| `minions_killed` | INTEGER | `MINIONS_KILLED` | 미니언 CS |
| `neutral_minions_killed` | INTEGER | `NEUTRAL_MINIONS_KILLED` | 정글 CS |
| `time_spent_dead` | INTEGER | `TOTAL_TIME_SPENT_DEAD` | 사망 시간(초) |
| `longest_time_living` | INTEGER | `LONGEST_TIME_SPENT_LIVING` | 최장 생존 시간 |
| `damage_to_turrets` | INTEGER | `TOTAL_DAMAGE_DEALT_TO_BUILDINGS` | 건물 피해 |
| `damage_to_objectives` | INTEGER | `TOTAL_DAMAGE_DEALT_TO_OBJECTIVES` | 오브젝트 피해 |
| `dragon_kills` | INTEGER | `DRAGON_KILLS` | |
| `baron_kills` | INTEGER | `BARON_KILLS` | |
| `herald_kills` | INTEGER | `RIFT_HERALD_KILLS` | |
| `horde_kills` | INTEGER | `HORDE_KILLS` | 공허 유충 |
| `last_takedown_time` | INTEGER | `LAST_TAKEDOWN_TIME` | |
| `turrets_killed` | INTEGER | `TURRETS_KILLED` | |
| `turret_takedowns` | INTEGER | `TURRET_TAKEDOWNS` | |
| `level` | INTEGER | `LEVEL` | 최종 레벨 |
| `exp` | INTEGER | `EXP` | 경험치 |
| `turret_plates_destroyed` | INTEGER | `Missions_TurretPlatesDestroyed` | 포탑 방패 |
| `takedowns_under_turret` | INTEGER | `Missions_TakedownsUnderTurret` | |
| `takedowns_before_15min` | INTEGER | `Missions_TakedownsBefore15Min` | |
| `jungle_cs_own` | INTEGER | `NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE` | 아군 정글 CS |
| `jungle_cs_enemy` | INTEGER | `NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE` | 적군 정글 CS |
| `damage_to_epic_monsters` | INTEGER | `TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS` | 에픽 몬스터 피해 (신포맷만 존재) |
| `objectives_stolen` | INTEGER | `OBJECTIVES_STOLEN` | 스틸 |
| `barracks_killed` | INTEGER | `BARRACKS_KILLED` | 억제기 |
| `heal_on_teammates` | INTEGER | `TOTAL_HEAL_ON_TEAMMATES` | 아군 힐량 |
| `shield_on_teammates` | INTEGER | `TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES` | 아군 실드량 |
| `enemy_missing_pings` | INTEGER | `ENEMY_MISSING_PINGS` | |
| `retreat_pings` | INTEGER | `RETREAT_PINGS` | |
| `on_my_way_pings` | INTEGER | `ON_MY_WAY_PINGS` | |
| `command_pings` | INTEGER | `COMMAND_PINGS` | |

> **구포맷/신포맷 구분**: raw_data에 `TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS` 키가 있으면 신포맷. 구포맷은 `damage_to_epic_monsters`를 NULL로 둔다. 핵심 플레이 스탯 키명은 두 포맷 동일.

### 2.3 파생지표 (raw에서 계산해 적재)

타입은 모두 `NUMERIC`. 산식은 §3 참조.

| 컬럼 | 설명 |
|---|---|
| `gold_per_min` | 분당 골드 |
| `dpm` | 분당 챔피언 피해 |
| `damage_taken_per_min` | 분당 받은 피해 |
| `cc_time_per_min` | 분당 CC 시간 |
| `exp_per_min` | 분당 경험치 |
| `damage_to_turrets_per_min` | 분당 건물 피해 |
| `cs_per_min` | 분당 CS (미니언+정글) |
| `wards_placed_per_min` | 분당 와드 설치 |
| `wards_killed_per_min` | 분당 와드 파괴 |
| `kda` | (킬+어시) / 데스 |
| `damage_taken_per_death` | 데스당 받은 피해 |
| `damage_dealt_per_death` | 데스당 가한 피해 |
| `dead_time_pct` | 사망 시간 비율(%) |
| `lane_gold_diff` | 동일 포지션 상대와의 골드 차 |

---

## 3. 파생지표 산식 (정확 재현 필수)

MMR 파이프라인(`features.py add_basic_features`, `silver.py clean_match_data`)과 **수치가 정확히 일치해야 한다.** 단위 변환을 틀리면 per-min 값이 60배 어긋난다.

### 3.1 공통 전처리

```text
분(minutes) = ROUND(game_duration / 60.0, 2)     # game_duration 은 초 단위
deaths_safe = (deaths = 0) ? 1 : deaths          # 0데스 방지
```

- **모든 파생지표는 최종 결과를 소수점 둘째 자리까지 반올림한다** (`ROUND(결과, 2)`).
- 분모가 0/NULL 이거나 결과가 inf/NaN 이면 **0으로 채운다** (`COALESCE(..., 0)`).
- 정수/정수 나눗셈 truncation 방지를 위해 분자를 실수(numeric)로 캐스팅.

### 3.2 산식

```text
gold_per_min              = gold_earned            / 분
dpm                       = damage_to_champions    / 분
damage_taken_per_min      = damage_taken           / 분
cc_time_per_min           = cc_time                / 분
exp_per_min               = exp                    / 분
damage_to_turrets_per_min = damage_to_turrets      / 분
cs_per_min                = (minions_killed + neutral_minions_killed) / 분
wards_placed_per_min      = wards_placed           / 분
wards_killed_per_min      = wards_killed           / 분

kda                       = (kills + assists)      / deaths_safe
damage_taken_per_death    = damage_taken           / deaths_safe
damage_dealt_per_death    = damage_to_champions    / deaths_safe

dead_time_pct             = time_spent_dead        / (분 * 60) * 100
lane_gold_diff            = gold_earned - (동일 replay_code+position 상대들의 평균 gold_earned)
```

### 3.3 `lane_gold_diff` 상세

같은 경기(`replay_code`) · 같은 포지션(`position`)의 **상대 라이너 평균 골드**와의 차이.

```sql
opponent_gold_sum = SUM(gold_earned) OVER (PARTITION BY replay_code, position) - gold_earned
opponent_count    = COUNT(*)         OVER (PARTITION BY replay_code, position) - 1
opponent_gold     = opponent_gold_sum / NULLIF(opponent_count, 0)
lane_gold_diff    = gold_earned - opponent_gold        -- 계산 불가 시 0
```

> 정상 5v5에서는 포지션당 2명이라 `opponent_count = 1`(상대 1명)이 된다.

### 3.4 참조 SQL

계산 로직의 구조는 `migrations/006_add_derived_metrics_to_player_game_stats.sql`를 참고한다(백엔드는 적재 시점에 동일 로직 적용). 단 **최종 저장값은 §3.1 규칙대로 소수점 둘째 자리 반올림**한다(참조 SQL에는 반올림이 빠져 있을 수 있음).

---

## 4. 구조 / 정합성 규칙

한 경기(`replay_code`)는 MMR 계산 대상이 되려면:

- 정확히 **10 row**
- 포지션별 정확히 **2 row** (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY 각 2)
- 각 `(position, win)` 조합마다 승자 1·패자 1
- 같은 경기 내 `puuid` 중복 없음

> 위반 경기는 MMR 부적격(백엔드 `is_mmr_eligible=false`) 처리. 적재 자체는 가능하나 MMR 계산에서 제외.

---

## 5. 인덱스 (권장)

```sql
CREATE INDEX ON match_participant_metric (replay_code);
CREATE INDEX ON match_participant_metric (puuid);
CREATE INDEX ON match_participant_metric (guild_id);
```

---

## 6. DDL 요약

```sql
CREATE TABLE match_participant_metric (
    id                              BIGSERIAL    PRIMARY KEY,
    replay_code                     VARCHAR(128) NOT NULL,
    puuid                           VARCHAR(64)  NOT NULL,
    guild_id                        VARCHAR(64),
    champion_id                     VARCHAR(16),
    team                            VARCHAR(8),
    position                        VARCHAR(16),
    win                             BOOLEAN,
    -- raw 지표 (§2.2)
    kills INTEGER, deaths INTEGER, assists INTEGER,
    double_kills INTEGER, triple_kills INTEGER, quadra_kills INTEGER, penta_kills INTEGER,
    killing_sprees INTEGER, largest_killing_spree INTEGER,
    gold_earned INTEGER, cc_time INTEGER, game_duration INTEGER,
    damage_to_champions INTEGER, damage_taken INTEGER, damage_self_mitigated INTEGER,
    vision_score INTEGER, wards_placed INTEGER, wards_killed INTEGER,
    detector_wards_placed INTEGER, control_wards_bought INTEGER,
    minions_killed INTEGER, neutral_minions_killed INTEGER,
    time_spent_dead INTEGER, longest_time_living INTEGER,
    damage_to_turrets INTEGER, damage_to_objectives INTEGER,
    dragon_kills INTEGER, baron_kills INTEGER, herald_kills INTEGER, horde_kills INTEGER,
    last_takedown_time INTEGER, turrets_killed INTEGER, turret_takedowns INTEGER,
    level INTEGER, exp INTEGER,
    turret_plates_destroyed INTEGER, takedowns_under_turret INTEGER, takedowns_before_15min INTEGER,
    jungle_cs_own INTEGER, jungle_cs_enemy INTEGER, damage_to_epic_monsters INTEGER,
    objectives_stolen INTEGER, barracks_killed INTEGER,
    heal_on_teammates INTEGER, shield_on_teammates INTEGER,
    enemy_missing_pings INTEGER, retreat_pings INTEGER, on_my_way_pings INTEGER, command_pings INTEGER,
    -- 파생지표 (§2.3, §3)
    gold_per_min NUMERIC, dpm NUMERIC, damage_taken_per_min NUMERIC, cc_time_per_min NUMERIC,
    exp_per_min NUMERIC, damage_to_turrets_per_min NUMERIC, cs_per_min NUMERIC,
    wards_placed_per_min NUMERIC, wards_killed_per_min NUMERIC,
    kda NUMERIC, damage_taken_per_death NUMERIC, damage_dealt_per_death NUMERIC,
    dead_time_pct NUMERIC, lane_gold_diff NUMERIC,
    -- 메타
    played_date                     TIMESTAMP,
    create_date                     TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
-- 파생지표(NUMERIC)는 모두 소수점 둘째 자리 반올림 값으로 저장 (§3)
```

---

## 7. 비고

- `kill_participation`, `damage_share`는 **포함하지 않는다** — 원본 데이터엔 있었으나 MMR 모델 입력에서 제외된 지표라 일관성을 위해 빼둔다.
- 파생지표는 raw에서 결정론적으로 재현 가능하므로, 백엔드가 적재 시 계산하든 MMR 서비스가 런타임 계산하든 결과는 동일해야 한다(§3 기준).
- 통신 계약(필드명/enum 변환)은 `docs/interface_spec.md` 기준.
