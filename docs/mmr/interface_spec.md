# MMR 인터페이스 정의서 (loltrix_be ↔ gmok_mmr)

> **목적**: 백엔드(`loltrix_be`)와 MMR 계산 서비스(`gmok_mmr`) 간 HTTP 인터페이스를 정의한다.
> **범위**: 와이어 입출력(요청/응답/에러)만. 산식 내부 계산은 gmok_mmr 책임이라 본 문서 밖.
> **기준 문서**: 본 정의서가 양 레포의 통신 계약(SoT). 코드가 이 문서와 다르면 코드가 잘못된 것이다.

| 항목 | 값 |
|---|---|
| Provider | gmok_mmr (Python / FastAPI, stateless) |
| Consumer | loltrix_be (Node.js / TypeScript) |
| 통신 | HTTP/JSON, 내부망 |
| 인증 | 없음 (내부망 신뢰) |
| Content-Type | `application/json` |
| 필드 네이밍 | **snake_case** |
| 버전 | URL prefix `/v1/` |

---

## 1. 엔드포인트 목록

| # | 메서드 | 경로 | 용도 | 타임아웃(권장) |
|---|---|---|---|---|
| 1 | POST | `/v1/mmr/baselines/calculate` | 시즌 baseline 학습 | 60s |
| 2 | POST | `/v1/mmr/matches/calculate` | 단일 경기 MMR 계산 (incremental/RECALC 공용) | 5s |
| 3 | GET | `/health` | 헬스체크 | 2s |

> RECALC 전용 엔드포인트는 없다. RECALC는 loltrix_be가 유저 상태를 초기화한 뒤 #2를 경기 순서대로 반복 호출하는 것과 동일하다.

---

## 2. 공통 정의

### 2.1 식별자

| 항목 | 필드 | 타입 | 예시 |
|---|---|---|---|
| 유저 | `puuid` | string | `"puuid-000001"` |
| 경기 | `custom_match_id` | string | `"CUSTOM-MATCH-260601-001"` |
| 참가자 행 | `match_participant_id` | integer | `123` |
| 길드 | `guild_id` | string | `"123456789"` |
| 시즌 | `season` | string | `"2026"` |
| 계산 실행 | `calculation_id` | string | `"MMR-20260601-V1StGXR8Z5"` |
| baseline | `baseline_version` | string | `"2026-06"` |

### 2.2 Enum

| 필드 | 허용 값 |
|---|---|
| `position` | `TOP` / `JUG` / `MID` / `ADC` / `SUP` |
| `game_team` | `blue` / `red` |
| `game_result` | `1`(승) / `0`(패) |

### 2.3 `calculation_id` 생성 규칙
- **loltrix_be가 생성**. 형식 `MMR-{YYYYMMDD}-{nanoid}` (날짜는 UTC).
- gmok_mmr은 받은 값을 **응답에 그대로 반환**한다(가공 금지).
- loltrix_be에서 `(calculation_id, match_participant_id)`가 멱등 저장 키.

---

## 3. 공통 데이터 구조 — Player-Game Row

경기 참가자 1명의 1경기 데이터. #1 `matches[]`, #2 `match_rows[]`의 원소.

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `custom_match_id` | string | ✅ | 경기 식별자 |
| `match_participant_id` | integer | ✅ | 참가자 행 식별자 |
| `guild_id` | string | ✅ | 길드 |
| `season` | string | ✅ | 시즌 |
| `puuid` | string | ✅ | 유저 |
| `champion_id` | string | ✅ | 챔피언 id |
| `game_team` | enum | ✅ | `blue`/`red` |
| `position` | enum | ✅ | `TOP`/`JUG`/`MID`/`ADC`/`SUP` |
| `game_result` | enum(0\|1) | ✅ | 승=1, 패=0 |
| `played_date` | string(ISO8601) | ✅ | 경기 플레이 시각 |
| `time_played` | integer | ✅ | 플레이 시간(초) |
| `kill` | integer | ✅ | |
| `death` | integer | ✅ | |
| `assist` | integer | ✅ | |
| `gold` | integer | ✅ | 획득 골드 |
| `ccing` | integer | ✅ | CC 기여 시간 |
| `exp` | integer | ✅ | 경험치 |
| `total_damage_champions` | integer | ✅ | 챔피언 가한 피해 |
| `total_damage_taken` | integer | ✅ | 받은 피해 |
| `vision_score` | integer | ✅ | 시야 점수 |
| `total_damage_dealt_to_buildings` | integer | ⬜ | 권장(Game Impact 정확도) |
| `vision_bought` | integer | ⬜ | 권장 |
| `minions_killed` | integer | ⬜ | 권장 |
| `neutral_minions_killed` | integer | ⬜ | 권장 |
| `wards_placed` | integer | ⬜ | 권장 |
| `wards_killed` | integer | ⬜ | 권장 |
| `time_spent_dead` | integer | ⬜ | 권장 |
| `heal_on_teammates` | integer | ⬜ | 권장 |
| `shield_on_teammates` | integer | ⬜ | 권장 |

> ✅ 필수, ⬜ 권장(누락 시 0으로 간주 가능). gmok_mmr은 받은 row가 전부 적격(loltrix가 사전 검증)이라고 가정한다.

---

## 4. API #1 — Baseline 계산

`POST /v1/mmr/baselines/calculate`

### 4.1 Request

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `season` | string | ✅ | 대상 시즌 |
| `baseline_version` | string | ✅ | loltrix 생성 버전 |
| `min_match_count` | integer | ✅ | 최소 경기 수(미만이면 422) |
| `matches` | Player-Game Row[] | ✅ | 시즌 전체 길드 통합 데이터(경기 수 제한 없음) |

### 4.2 Response 200

| 필드 | 타입 | 설명 |
|---|---|---|
| `season` | string | |
| `baseline_version` | string | |
| `mmr_baseline` | object | `{ f1_mean: number, f2_mean: number }` |
| `game_impact_baseline` | object | `{ position_weights, outcome_stats }` (§6 구조) |
| `metadata` | object | `{ match_count, player_game_row_count, calculated_at }` |

```json
{
  "season": "2026",
  "baseline_version": "2026-06",
  "mmr_baseline": { "f1_mean": 1.0, "f2_mean": 50.0 },
  "game_impact_baseline": {
    "position_weights": { "TOP": { "kill": 0.12, "death": 0.08, "assist": 0.05 } },
    "outcome_stats": [ { "position": "TOP", "game_result": 1, "lower": 12.3, "upper": 87.5 } ]
  },
  "metadata": { "match_count": 1000, "player_game_row_count": 10000, "calculated_at": "2026-06-01T00:00:00Z" }
}
```

### 4.3 Error

| HTTP | error_code | 조건 |
|---|---|---|
| 422 | `INSUFFICIENT_DATA` | 경기 수 < `min_match_count` |
| 400 | `MISSING_REQUIRED_COLUMN` | 필수 컬럼 누락 |
| 400 | `INVALID_MATCH_STRUCTURE` | row 구조 오류 |

---

## 5. API #2 — 단일 경기 MMR 계산

`POST /v1/mmr/matches/calculate`

### 5.1 Request

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `guild_id` | string | ✅ | |
| `season` | string | ✅ | |
| `calculation_id` | string | ✅ | loltrix 생성, 응답에 그대로 반환 |
| `custom_match_id` | string | ✅ | |
| `baseline_version` | string | ✅ | 사용 baseline 버전 |
| `mmr_baseline` | object | ✅ | #1 응답의 `mmr_baseline` 그대로 |
| `game_impact_baseline` | object | ✅ | #1 응답의 `game_impact_baseline` 그대로 |
| `match_rows` | Player-Game Row[] | ✅ | **정확히 10개** |
| `pre_match_user_summary` | object[] | ✅ | 참가자 10명의 계산 직전 포지션별 상태 |

**`pre_match_user_summary[]` 원소**

| 필드 | 타입 | 설명 |
|---|---|---|
| `puuid` | string | |
| `positions` | object[] | `{ position, pos_mmr:int, pos_games:int, pos_wins:int }[]` |

> 누락된 참가자/포지션은 gmok_mmr이 신규(`pos_mmr=1300, pos_games=0, pos_wins=0`)로 간주한다. `match_rows`의 position과 `pre_match_user_summary`의 positions는 일치할 필요 없음(유저가 여러 포지션 이력 보유 가능).

### 5.2 Response 200

| 필드 | 타입 | 설명 |
|---|---|---|
| `guild_id` / `season` / `calculation_id` / `custom_match_id` / `baseline_version` | string | 요청 echo |
| `match_results` | object[] | 참가자별 계산 결과(아래) |
| `updated_user_summary` | object[] | 참가자별 갱신 후 상태(아래) |
| `mmr_history` | object[] | 참가자별 변동 이력(아래) |
| `metadata` | object | `{ calculated_at }` |

**`match_results[]` 원소**

| 필드 | 타입 | 설명 |
|---|---|---|
| `custom_match_id` | string | |
| `match_participant_id` | integer | |
| `puuid` | string | |
| `position` | enum | |
| `game_result` | enum(0\|1) | |
| `pre_game_mmr` | integer | 경기 전 포지션 MMR |
| `expected_score` | number | ELO 기대 점수 |
| `actual_score` | number | 실제 기여 점수 |
| `relative_factor` | number | |
| `personal_factor` | number | |
| `final_factor` | number | |
| `mmr_change` | integer | 변동량(±) |
| `post_game_mmr` | integer | 경기 후 포지션 MMR |

**`updated_user_summary[]` 원소**

| 필드 | 타입 | 설명 |
|---|---|---|
| `puuid` | string | |
| `total_mmr` | integer | 포지션 가중평균 |
| `total_games` | integer | |
| `total_wins` | integer | |
| `positions` | object[] | `{ position, pos_mmr, pos_games, pos_wins }[]` (절댓값) |

**`mmr_history[]` 원소**

| 필드 | 타입 | 설명 |
|---|---|---|
| `puuid` | string | |
| `custom_match_id` | string | |
| `position` | enum | |
| `mmr_delta` | integer | 변동량 |
| `before_mmr` / `after_mmr` | integer | 변동 전/후 total MMR |
| `before_pos_mmr` / `after_pos_mmr` | integer | 변동 전/후 포지션 MMR |

### 5.3 Error

| HTTP | error_code | 조건 |
|---|---|---|
| 400 | `MISSING_REQUIRED_COLUMN` | 필수 컬럼 누락 |
| 400 | `INVALID_MATCH_STRUCTURE` | 10행 아님 / 포지션·승패 구조 오류 |
| 400 | `INVALID_POSITION` | enum 외 포지션 |
| 400 | `INVALID_GAME_TEAM` | enum 외 팀 |
| 400 | `INVALID_GAME_RESULT` | enum 외 승패 |
| 400 | `INVALID_BASELINE` | baseline 누락/형식 오류 |
| 400 | `INSUFFICIENT_USER_STATE` | `pre_match_user_summary` 없음 |
| 500 | `CALCULATION_FAILED` | 내부 계산 예외 |

---

## 6. baseline 데이터 구조 (안정성 정책)

| 키 | 구조 | 변경 정책 |
|---|---|---|
| `mmr_baseline` | `{ f1_mean, f2_mean }` | 키 추가만 허용, 제거·이름변경 금지 |
| `game_impact_baseline.position_weights` | `{ position: { metric: weight } }` | 중첩 dict |
| `game_impact_baseline.outcome_stats` | `[ { position, game_result, lower, upper } ]` | 배열 |

---

## 7. 공통 에러 응답 포맷

```json
{ "error_code": "INVALID_MATCH_STRUCTURE", "message": "each match must have exactly 10 player rows", "details": { "custom_match_id": "...", "row_count": 9 } }
```

| 필드 | 타입 | 필수 |
|---|---|---|
| `error_code` | string | ✅ |
| `message` | string | ✅ |
| `details` | object | ⬜ |

---

## 8. 입력 검증 규칙 (gmok_mmr 책임)

`match_rows` 내 각 `custom_match_id`는:
- 정확히 **10개 row**
- 포지션별 정확히 **2개**(TOP×2, JUG×2, MID×2, ADC×2, SUP×2)
- 각 `(position, game_result)`마다 승자 1·패자 1
- 같은 경기 내 `puuid` 중복 없음
- `position`/`game_team`/`game_result` 모두 정의된 enum

위반 시 HTTP 400 + 해당 `error_code`.

---

## 9. 에러 처리 정책 (loltrix_be 측 동작)

| 상황 | loltrix_be 동작 |
|---|---|
| 400 (검증 실패) | 해당 경기 처리 `fail`, **자동 재시도 없음**, 관리자 알람 |
| 422 `INSUFFICIENT_DATA` | baseline 계산 실패, 관리자 알람 |
| 5xx / timeout | 해당 작업 재시도(최대 3회), 초과 시 fail |
| gmok_mmr 다운 | 해당 처리 주기 전체 skip, 다음 주기 자동 재시도 |

---

## 10. 버전 / 일관성 정책

- URL 버전 `/v1/`. 하위호환 깨지는 변경 시 `/v2/`.
- 요청/응답 **필드 추가는 비파괴적**. 제거·이름변경은 버전 상향.
- **baseline은 매 #2 호출에 동일하게 전달**한다(학습된 weights 고정 적용). RECALC마다 재학습 금지 — incremental 누적과 RECALC 결과가 달라지지 않게.

---

*상세 설계 맥락은 `docs/mmr/00_overview.md` ~ `03_api_contract.md` 참조. 본 정의서는 그 중 통신 계약(03)을 인터페이스 정의서 포맷으로 재구성한 것이다.*
</content>
