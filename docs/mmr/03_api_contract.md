# MMR API 계약 (loltrix_be ↔ gmok_mmr)

> 짝 문서: [00_overview.md](./00_overview.md) | [01_architecture.md](./01_architecture.md) | [02_data_model.md](./02_data_model.md)
>
> **이 문서가 양 레포의 통신 계약(SoT)이다.**
> 코드 내부 식별자가 이 문서와 다르면 코드가 잘못된 것이다.

---

## 1. 엔드포인트 목록

| 메서드 | 경로 | 호출 주체 | 빈도 |
|---|---|---|---|
| `POST` | `/v1/mmr/baselines/calculate` | 운영자 수동 트리거 (admin API 경유) | 시즌 시작 시 또는 필요 시 |
| `POST` | `/v1/mmr/matches/calculate` | incremental worker / RECALC 루프 | 30분 주기 cron, 경기당 1회 |
| `GET` | `/health` | worker 선택적 ping | 선택 |

> `/v1/mmr/recalculate`는 없다. RECALC는 loltrix_be가 mmr_member_summary를 초기화한 뒤
> `/v1/mmr/matches/calculate`를 경기 순서대로 반복 호출하는 것과 수학적으로 동일하다.

---

## 2. 공통 식별자 / Enum

### 식별자

| 항목 | 필드명 | 예시 |
|---|---|---|
| 유저 | `puuid` | `"puuid-000001"` |
| 경기 | `custom_match_id` | `"CUSTOM-MATCH-260601-001"` |
| 참가자 행 | `match_participant_id` | `123` (integer) |
| 길드 | `guild_id` | `"123456789"` |
| 시즌 | `season` | `"2026"` |
| 계산 실행 | `calculation_id` | `"MMR-20260601-V1StGXR8Z5"` (loltrix_be가 nanoid로 생성) |
| baseline | `baseline_version` | `"2026-06"` |

### Enum

| 필드 | 허용 값 |
|---|---|
| `position` | `TOP`, `JUG`, `MID`, `ADC`, `SUP` |
| `game_team` | `blue`, `red` |
| `game_result` | `1` (승), `0` (패) |

---

## 3. Player-Game Row (공통 payload 단위)

`mmr_participant_metric`에서 **변환**해 조립한다(1:1 아님). metric은 [정의서](match_participant_metric_table_spec.md) 기준 raw 49 + 파생 14의 풍부한 저장 포맷이고, 이 row는 gmok에 보내는 **얇은 전송 포맷**이다. 변환은 두 가지뿐:
- **필드명 리네임**: metric `kills`/`gold_earned`/`game_duration`/`damage_to_champions`/`damage_to_turrets`/`control_wards_bought` → row `kill`/`gold`/`time_played`/`total_damage_champions`/`total_damage_dealt_to_buildings`/`vision_bought` 등. metric raw 중 **아래 필드만** 전송(나머지는 저장 전용).
- **`match_participant_id` 부착**: metric엔 없으므로(자연키 `(custom_match_id, puuid)`) `match_participant` join으로 채운다([step08 §5](steps/step08_incremental_worker.md)).

값(blue/red·position enum·game_result 1/0)은 metric이 이미 변환값으로 저장하므로 추가 변환 없음. loltrix_be가 이 구조를 조립해 gmok_mmr에 전달하고, gmok_mmr은 받은 row가 전부 유효(is_mmr_eligible=true)하다고 가정한다.

```json
{
  "custom_match_id": "CUSTOM-MATCH-260601-001",
  "match_participant_id": 123,
  "guild_id": "123456789",
  "season": "2026",
  "puuid": "puuid-000001",
  "champion_id": "1",
  "game_team": "blue",
  "position": "TOP",
  "game_result": 1,
  "played_date": "2026-06-01T12:00:00Z",

  "time_played": 1800,
  "kill": 4,
  "death": 2,
  "assist": 6,
  "gold": 12000,
  "ccing": 20,
  "exp": 15000,
  "total_damage_champions": 23000,
  "total_damage_taken": 18000,
  "vision_score": 25,

  "total_damage_dealt_to_buildings": 2500,
  "vision_bought": 1,
  "minions_killed": 180,
  "neutral_minions_killed": 12,
  "wards_placed": 8,
  "wards_killed": 3,
  "time_spent_dead": 120,
  "heal_on_teammates": 0,
  "shield_on_teammates": 0
}
```

**필수 필드**: `custom_match_id`, `match_participant_id`, `guild_id`, `season`, `puuid`, `champion_id`, `game_team`, `position`, `game_result`, `played_date`, `time_played`, `kill`, `death`, `assist`, `gold`, `ccing`, `exp`, `total_damage_champions`, `total_damage_taken`, `vision_score`

**권장 필드** (Game Impact 정확도 향상): `total_damage_dealt_to_buildings`, `vision_bought`, `minions_killed`, `neutral_minions_killed`, `wards_placed`, `wards_killed`, `time_spent_dead`, `heal_on_teammates`, `shield_on_teammates`

---

## 4. API 1 — Baseline 계산

```
POST /v1/mmr/baselines/calculate
```

### 4.1 Request

```json
{
  "season": "2026",
  "baseline_version": "2026-06",
  "min_match_count": 200,
  "matches": [ /* player-game row 배열, 경기 수 제한 없음 */ ]
}
```

`matches`에는 해당 시즌의 모든 길드 데이터를 통합해서 넣는다 (`guild_id` 포함).
`baseline_version`은 loltrix_be가 생성 (`"YYYY-MM"` 형식 권장).

### 4.2 Response (200)

```json
{
  "season": "2026",
  "baseline_version": "2026-06",
  "mmr_baseline": {
    "f1_mean": 1.0,
    "f2_mean": 50.0
  },
  "game_impact_baseline": {
    "position_weights": {
      "TOP": { "kill": 0.12, "death": 0.08, "assist": 0.05 },
      "JUG": { "kill": 0.10, "death": 0.09, "assist": 0.07 },
      "MID": { "kill": 0.13, "death": 0.07, "assist": 0.05 },
      "ADC": { "kill": 0.14, "death": 0.06, "assist": 0.04 },
      "SUP": { "kill": 0.05, "death": 0.05, "assist": 0.14 }
    },
    "outcome_stats": [
      { "position": "TOP", "game_result": 1, "lower": 12.3, "upper": 87.5 },
      { "position": "TOP", "game_result": 0, "lower":  8.1, "upper": 75.4 }
    ]
  },
  "metadata": {
    "match_count": 1000,
    "player_game_row_count": 10000,
    "calculated_at": "2026-06-01T00:00:00Z"
  }
}
```

loltrix_be는 이 응답을 `mmr_season_baseline.baseline_data`에 JSON으로 저장한다.
이후 `/v1/mmr/matches/calculate` 호출 시마다 `mmr_baseline` + `game_impact_baseline`을 request에 포함시킨다.

### 4.3 에러

| HTTP | error_code | 조건 |
|---|---|---|
| 422 | `INSUFFICIENT_DATA` | 경기 수 < `min_match_count` |
| 400 | `MISSING_REQUIRED_COLUMN` | 필수 컬럼 누락 |
| 400 | `INVALID_MATCH_STRUCTURE` | row 구조 오류 |

```json
{
  "error_code": "INSUFFICIENT_DATA",
  "message": "baseline requires at least 200 matches, got 47",
  "details": { "received_match_count": 47, "required": 200 }
}
```

---

## 5. API 2 — 단일 경기 MMR 계산 (Incremental / RECALC 공용)

```
POST /v1/mmr/matches/calculate
```

incremental worker가 가장 자주 호출하는 API. RECALC는 이 API를 경기 순서대로 반복 호출하는 것과 동일.

### 5.1 Request

```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-bL4f0pQ2xK",
  "custom_match_id": "CUSTOM-MATCH-260601-002",
  "baseline_version": "2026-06",
  "mmr_baseline": { "f1_mean": 1.0, "f2_mean": 50.0 },
  "game_impact_baseline": { /* 4.2 응답의 game_impact_baseline 그대로 */ },
  "match_rows": [ /* 정확히 10개 player-game row */ ],
  "pre_match_user_summary": [
    {
      "puuid": "puuid-000001",
      "positions": [
        { "position": "TOP", "pos_mmr": 1300, "pos_games": 3, "pos_wins": 2 },
        { "position": "MID", "pos_mmr": 1280, "pos_games": 1, "pos_wins": 0 }
      ]
    }
  ]
}
```

**`pre_match_user_summary`**: 이 경기 참가자 10명의 계산 직전 포지션별 state.
- loltrix_be가 `mmr_member_summary`에서 조회해서 조립.
- 누락된 참가자 또는 포지션은 gmok_mmr이 신규(`pos_mmr=1300, pos_games=0, pos_wins=0`)로 간주.
- `match_rows`의 `position`과 `pre_match_user_summary`의 `positions`는 일치할 필요 없음 — 참가자가 여러 포지션 이력을 가질 수 있음.

**`calculation_id`**: loltrix_be가 생성. 형식: `"MMR-YYYYMMDD-{nanoid}"` (§10).
응답에 그대로 반환되어 `mmr_match_result.calculation_id`에 저장됨. idempotent upsert 키.

### 5.2 Response (200)

```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-bL4f0pQ2xK",
  "custom_match_id": "CUSTOM-MATCH-260601-002",
  "baseline_version": "2026-06",
  "match_results": [
    {
      "custom_match_id": "CUSTOM-MATCH-260601-002",
      "match_participant_id": 123,
      "puuid": "puuid-000001",
      "position": "TOP",
      "game_result": 1,
      "pre_game_mmr": 1300,
      "expected_score": 0.5000,
      "actual_score": 0.6200,
      "relative_factor": 1.2400,
      "personal_factor": 1.0800,
      "final_factor": 1.1300,
      "mmr_change": 23,
      "post_game_mmr": 1323
    }
  ],
  "updated_user_summary": [
    {
      "puuid": "puuid-000001",
      "total_mmr": 1323,
      "total_games": 4,
      "total_wins": 3,
      "positions": [
        { "position": "TOP", "pos_mmr": 1323, "pos_games": 4, "pos_wins": 3 },
        { "position": "MID", "pos_mmr": 1280, "pos_games": 1, "pos_wins": 0 }
      ]
    }
  ],
  "mmr_history": [
    {
      "puuid": "puuid-000001",
      "custom_match_id": "CUSTOM-MATCH-260601-002",
      "position": "TOP",
      "mmr_delta": 23,
      "before_mmr": 1300,
      "after_mmr": 1323,
      "before_pos_mmr": 1300,
      "after_pos_mmr": 1323
    }
  ],
  "metadata": {
    "calculated_at": "2026-06-01T00:20:00Z"
  }
}
```

**loltrix_be 저장 책임**:

| 응답 필드 | 저장 대상 테이블 |
|---|---|
| `match_results` | `mmr_match_result` (UPSERT on `calculation_id, match_participant_id`) |
| `mmr_history` | `mmr_history` (INSERT) |
| `updated_user_summary` | `mmr_member_summary` (UPSERT on `guild_id, season, puuid`) |
| — | `mmr_match_queue.status = done` |

모두 단일 트랜잭션 처리.

### 5.3 에러

| HTTP | error_code | 조건 |
|---|---|---|
| 400 | `MISSING_REQUIRED_COLUMN` | 필수 컬럼 누락 |
| 400 | `INVALID_MATCH_STRUCTURE` | 경기가 정확히 10행이 아님, 포지션/승패 구조 오류 |
| 400 | `INVALID_POSITION` | enum 외 포지션 |
| 400 | `INVALID_GAME_TEAM` | enum 외 팀 |
| 400 | `INVALID_GAME_RESULT` | enum 외 승패 값 |
| 400 | `INVALID_BASELINE` | mmr_baseline / game_impact_baseline 누락 또는 형식 오류 |
| 400 | `INSUFFICIENT_USER_STATE` | pre_match_user_summary 없음 |
| 500 | `CALCULATION_FAILED` | 내부 계산 예외 |

```json
{
  "error_code": "INVALID_MATCH_STRUCTURE",
  "message": "each match must have exactly 10 player rows",
  "details": { "custom_match_id": "CUSTOM-MATCH-260601-002", "row_count": 9 }
}
```

---

## 6. 입력 검증 규칙 (gmok_mmr 검증 책임)

`match_rows` 내 각 `custom_match_id`는:
- 정확히 10개 row
- 포지션별 정확히 2개 row (TOP×2, JUG×2, MID×2, ADC×2, SUP×2)
- 각 `(position, game_result)` 조합마다 승자 1명 / 패자 1명
- 같은 경기 내 `puuid` 중복 없음
- `position`, `game_team`, `game_result` 모두 정의된 enum 값

검증 실패 시 HTTP 400 + 에러 코드. loltrix_be는 400 수신 시 해당 경기를 `mmr_match_queue.status = fail`로 전환한다.

---

## 7. MMR 산식 (v1 확정)

### 7.1 기본 파라미터

```
INITIAL_MMR        = 1300
BASE_WIN           = 20
BASE_LOSS          = -15
MMR_MIN_CHANGE     = -25
MMR_MAX_CHANGE     = 30
MMR_K_DECAY_START  = 1500
MMR_K_DECAY_RATE   = 0.002
MMR_K_MIN          = 0.35
ALPHA              = 0.6    # 개인 기여도 가중치
BETA               = 0.4    # 상대 비교 가중치
GAMMA              = 0.2    # ELO 기대 대비 실제
WIN_FLOOR          = +12    # 최소 획득 MMR (내전 변동 체감 보장)
LOSS_FLOOR         = -12    # 최대 손실 MMR (절댓값 기준)
```

WIN_FLOOR/LOSS_FLOOR 12/-12는 의도된 정책이다. 내전 특성상 변동이 너무 작으면 사용자가 체감 못함. 조정 시 이 문서에서 먼저 변경.

### 7.2 계산 순서 (경기당)

```
1. 경기 시작 시점의 (puuid, position)별 pre_pos_mmr snapshot (pre_match_user_summary에서)

2. 각 row마다:
   a. 같은 포지션 상대(opponent) pos_mmr 조회
   b. expected_score = 1 / (1 + 10^((opp_mmr - my_mmr) / 400))      ← ELO
   c. actual_score = game_impact_vs_opponent / 100   (NaN이면 expected 사용)
   d. relative_factor = actual / expected             (clip 0.5~2.0)
   e. f1 = game_n_person_contribution / mmr_baseline.f1_mean         (clip 0.5~2.0)
      f2 = game_impact_vs_opponent    / mmr_baseline.f2_mean         (clip 0.5~2.0)
      personal_factor = f1^ALPHA × f2^BETA
   f. final_factor = personal_factor × relative_factor^GAMMA
   g. k = max(K_MIN, 1 - max(0, (current_mmr - K_DECAY_START) × K_DECAY_RATE))
   h. 승: delta = clip(max(BASE_WIN  × final_factor × k, WIN_FLOOR),  WIN_FLOOR,  MMR_MAX_CHANGE)
      패: delta = clip(min(BASE_LOSS × final_factor × k, LOSS_FLOOR), MMR_MIN_CHANGE, LOSS_FLOOR)

3. post_pos_mmr = pre_pos_mmr + delta

4. total_mmr = Σ(pos_mmr × pos_games) / Σpos_games   ← 포지션별 가중 평균
```

### 7.3 산식 일관성 (RECALC = incremental 반복)

RECALC 시 loltrix_be는 `mmr_member_summary`를 초기화(total_mmr=1300, games=0)한 뒤 incremental 엔드포인트를 경기 순서대로 반복 호출한다. gmok_mmr 관점에서는 incremental 요청과 완전히 동일하다.

**baseline은 매 호출마다 동일하게 전달**한다 (학습된 `position_weights` / `outcome_stats` 고정 적용).

- ❌ RECALC마다 RandomForest 재학습
- ✅ 저장된 `game_impact_baseline`을 그대로 매 요청에 포함

이 원칙이 깨지면 RECALC 직후와 incremental 누적 결과가 달라진다.

---

## 8. Baseline 데이터 구조 안정성 정책

- `mmr_baseline`: `{ f1_mean, f2_mean }` — 향후 키 추가만 허용, 기존 키 제거·이름 변경 금지
- `game_impact_baseline.position_weights`: `{ position: { metric: weight } }` 중첩 dict
- `game_impact_baseline.outcome_stats`: `[ { position, game_result, lower, upper } ]` 배열

---

## 9. loltrix_be ← gmok_mmr 통신 에러 처리 정책

| 상황 | loltrix_be 동작 |
|---|---|
| HTTP 400 (검증 실패) | 해당 경기 `mmr_match_queue.status = fail`. 자동 재시도 없음. 관리자 알람 대상 |
| HTTP 422 `INSUFFICIENT_DATA` | baseline 계산 실패. `mmr_guild_state.status = error`. 관리자 알람 |
| HTTP 500 / timeout | 해당 경기 skip, 다음 worker tick에서 재시도 (max 3회). 3회 초과 시 fail |
| gmok_mmr 서버 다운 | 해당 tick 전체 skip. `mmr_guild_state` 잠금 해제. 다음 tick 자동 재시도 |

---

## 10. `calculation_id` 생성 규칙

loltrix_be가 생성. 형식: `MMR-{YYYYMMDD}-{nanoid}`

```
예: MMR-20260601-V1StGXR8Z5
    MMR-20260601-bL4f0pQ2xK
```

- 날짜는 UTC 기준 실행일
- 접미사는 **nanoid**(기본 길이, URL-safe). DB 시퀀스/카운터 불필요, 동시 생성 충돌 없음
- gmok_mmr 응답에 그대로 포함되어 반환됨
- `mmr_match_result.calculation_id` + `match_participant_id` 조합으로 idempotent UPSERT

---

## 11. 버전 정책

- URL 버전: `/v1/` — 하위 호환 깨지는 변경 시 `/v2/`로 올림
- 요청/응답에 필드 추가는 비파괴적. 제거/이름 변경은 버전 올림 필요
