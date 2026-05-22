# MMR 서비스 설계 (확정본)

> 이 문서는 `trcgg/gmok_mmr`(MMR 서비스) 관점의 설계 확정본이다.
> 짝 문서: `docs/MMR_BACKEND_DESIGN.md` (백엔드 측 설계 — `trcgg/loltrix_be`)
>
> **이 문서가 양 레포의 통신 계약(SoT)이다.**
> 코드 내부 식별자가 이 문서와 다르면 코드가 잘못된 것이다.

## 0. 목적

백엔드(`loltrix_be`)와 MMR 계산 서비스(`gmok_mmr`)의 통신 계약 + MMR 서비스 내부 구조 확정.

## 1. 아키텍처 결정 사항 (서비스 관점)

| # | 항목 | 결정 |
|---|---|---|
| A | 운영 모드 | **별도 인스턴스에서 FastAPI 상시 가동.** 백엔드와 분리. |
| B | 호출 패턴 | 백엔드에서 5분 주기 batch + 신규 구독 시 즉시 RECALC |
| C | 단일 경기 API | **활성화.** 이게 일상 운영의 메인 경로 |
| D | 포지션별 state | 백엔드가 보냄(`pre_match_user_summary`). MMR 서비스는 stateless |
| E | 컬럼/식별자/enum | **백엔드 contract 기준으로 코드 내부까지 통일** (대규모 rename 필요) |
| F | baseline 데이터 부족 | `INSUFFICIENT_DATA` 에러 응답 |
| G | 산식 일관성 | 학습/적용 산식 통일 (RECALC도 `apply_*` 경로 사용) |
| H | 의존성 | 런타임: pandas, numpy, scikit-learn, fastapi, uvicorn, psycopg2만 |

## 2. 식별자 / Enum / 단위 (백엔드와 100% 동일)

### 식별자
| 항목 | 값 |
|---|---|
| 유저 식별자 | `puuid` |
| 경기 식별자 | `custom_match_id` |
| 길드 식별자 | `guild_id` |
| 시즌 식별자 | `season` |
| 계산 실행 식별자 | `calculation_id` |
| baseline 식별자 | `baseline_version` |

### Enum
| 필드 | 값 |
|---|---|
| `position` | `TOP`, `JUG`, `MID`, `ADC`, `SUP` |
| `game_team` | `blue`, `red` |
| `game_result` | `1`(승), `0`(패) |

## 3. 컬럼명 통일 (코드 rename 대상)

MMR 서비스(`gmok_mmr`) 내부 코드가 사용하는 컬럼명을 백엔드 contract 기준으로 일괄 변경한다.

| Before (현재 코드) | After (contract 기준) |
|---|---|
| `kills` | `kill` |
| `deaths` | `death` |
| `assists` | `assist` |
| `game_duration` (분 단위 변환) | `time_played` (초) — 내부에서 사용 시 분 환산 헬퍼 사용 |
| `cc_time` | `ccing` |
| `damage_to_champions` | `total_damage_champions` |
| `damage_taken` | `total_damage_taken` |
| `damage_to_turrets` | `total_damage_dealt_to_buildings` |
| `replay_code` | `custom_match_id` |
| `BOTTOM` | `ADC` |
| `MIDDLE` | `MID` |
| `JUNGLE` | `JUG` |
| `UTILITY` | `SUP` |
| `gold_earned` | `gold` |
| `pre_game_pos_mmr` | `pre_game_mmr` (응답) |
| `pos_cumulative_mmr` | `post_game_mmr` (응답) |

**산식은 변경하지 않는다.** 컬럼 alias만 바꾸는 작업.

영향 파일(현재 구조 기준):
- `src/mmr_refactor/features.py`
- `src/mmr_refactor/silver.py`
- `src/mmr_refactor/mmr.py`
- `src/mmr_refactor/game_impact.py`
- `src/mmr_refactor/baseline.py`
- `src/mmr_refactor/service.py`
- `src/mmr_refactor/api_server.py`
- `tests/*` 전반

`service.py`의 `_normalize_source_columns()`는 rename 완료 후 **제거 또는 idempotent guard로 축소**.

## 4. Player-Game Payload (정식 계약)

```json
{
  "custom_match_id": "CUSTOM-MATCH-260601-001",
  "participant_id": 123,
  "guild_id": "123456789",
  "season": "2026",
  "puuid": "puuid-000001",
  "champion_id": "1",
  "game_team": "blue",
  "position": "TOP",
  "game_result": 1,
  "time_played": 1800,
  "kill": 4,
  "death": 2,
  "assist": 6,
  "gold": 12000,
  "ccing": 20,
  "exp": 15000,
  "total_damage_champions": 23000,
  "total_damage_dealt_to_buildings": 2500,
  "total_damage_taken": 18000,
  "vision_score": 25,
  "vision_bought": 1,
  "minions_killed": 180,
  "neutral_minions_killed": 12,
  "wards_placed": 8,
  "wards_killed": 3,
  "time_spent_dead": 120,
  "heal_on_teammates": 0,
  "shield_on_teammates": 0,
  "feature_version": "2026-06",
  "played_at": "2026-06-01T12:00:00Z"
}
```

### 필수 필드
`custom_match_id`, `participant_id`, `guild_id`, `season`, `puuid`, `champion_id`, `game_team`, `position`, `game_result`, `time_played`, `kill`, `death`, `assist`, `gold`, `ccing`, `exp`, `total_damage_champions`, `total_damage_taken`, `vision_score`, `played_at`

### 권장 필드 (Game Impact 정확도 향상)
`total_damage_dealt_to_buildings`, `vision_bought`, `minions_killed`, `neutral_minions_killed`, `wards_placed`, `wards_killed`, `time_spent_dead`, `heal_on_teammates`, `shield_on_teammates`, `feature_version`

> 백엔드가 `is_mmr_eligible=false`인 경기는 전부 제외하고 보낸다. MMR 서비스는 받은 경기 전부 유효하다고 가정한다.

## 5. API 1. Baseline 계산

```http
POST /v1/mmr/baselines/calculate
```

### Request
```json
{
  "season": "2026",
  "baseline_version": "2026-06",
  "min_match_count": 200,
  "matches": [ /* player-game row 배열 */ ]
}
```

### Response (200)
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
      "TOP": { "kill": 0.12, "death": 0.08, ... },
      "JUG": { ... },
      "MID": { ... },
      "ADC": { ... },
      "SUP": { ... }
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

### 에러
경기 수 < `min_match_count`인 경우:
```json
{
  "error_code": "INSUFFICIENT_DATA",
  "message": "baseline requires at least 200 matches, got 47",
  "details": { "received_match_count": 47, "required": 200 }
}
```
HTTP 422.

## 6. API 2. 전체 MMR 계산 (RECALC)

```http
POST /v1/mmr/recalculate
```

### Request
```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-0001",
  "baseline_version": "2026-06",
  "mmr_baseline": { "f1_mean": 1.0, "f2_mean": 50.0 },
  "game_impact_baseline": { /* baseline 응답과 동일 구조 */ },
  "matches": [ /* player-game row 배열, played_at asc 정렬됨 */ ]
}
```

### Response
```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-0001",
  "baseline_version": "2026-06",
  "match_results": [
    {
      "custom_match_id": "CUSTOM-MATCH-260601-001",
      "participant_id": 123,
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
  "user_summary": [
    {
      "puuid": "puuid-000001",
      "total_mmr": 1323,
      "total_games": 10,
      "total_wins": 6,
      "positions": [
        { "position": "TOP", "pos_mmr": 1323, "pos_games": 10, "pos_wins": 6 }
      ]
    }
  ],
  "mmr_history": [
    {
      "puuid": "puuid-000001",
      "custom_match_id": "CUSTOM-MATCH-260601-001",
      "position": "TOP",
      "history_type": "MATCH_RESULT",
      "mmr_delta": 23,
      "before_mmr": 1300,
      "after_mmr": 1323,
      "before_pos_mmr": 1300,
      "after_pos_mmr": 1323,
      "source_calculation_id": "MMR-20260601-0001",
      "reason": "match result"
    }
  ],
  "metadata": {
    "match_count": 100,
    "player_game_row_count": 1000,
    "calculated_at": "2026-06-01T00:10:00Z"
  }
}
```

응답 크기가 큰 경우(`match_count > 1000`) 향후 NDJSON 스트리밍 도입 검토(v2).

## 7. API 3. 단일 경기 MMR 계산 (Incremental — 메인 경로)

```http
POST /v1/mmr/matches/calculate
```

백엔드 5분 cron worker가 가장 자주 호출하는 API.

### Request
```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-0002",
  "custom_match_id": "CUSTOM-MATCH-260601-002",
  "baseline_version": "2026-06",
  "mmr_baseline": { "f1_mean": 1.0, "f2_mean": 50.0 },
  "game_impact_baseline": { /* ... */ },
  "match_rows": [ /* 정확히 10개 player-game row */ ],
  "pre_match_user_summary": [
    {
      "puuid": "puuid-000001",
      "positions": [
        { "position": "TOP", "pos_mmr": 1300, "pos_games": 3, "pos_wins": 2 }
      ]
    }
  ]
}
```

`pre_match_user_summary`는 **이 경기 참가자 10명 전원**의 포지션별 현재 state. 누락된 참가자/포지션은 신규(`pos_mmr=1300, pos_games=0, pos_wins=0`)로 간주.

### Response
```json
{
  "guild_id": "123456789",
  "season": "2026",
  "calculation_id": "MMR-20260601-0002",
  "custom_match_id": "CUSTOM-MATCH-260601-002",
  "baseline_version": "2026-06",
  "match_results": [ /* RECALC와 동일 구조, 길이 10 */ ],
  "updated_user_summary": [
    {
      "puuid": "puuid-000001",
      "total_mmr": 1323,
      "total_games": 4,
      "total_wins": 3,
      "positions": [
        { "position": "TOP", "pos_mmr": 1323, "pos_games": 4, "pos_wins": 3 }
      ]
    }
  ],
  "mmr_history": [ /* RECALC와 동일 구조 */ ],
  "metadata": {
    "calculated_at": "2026-06-01T00:20:00Z",
    "mode": "incremental"
  }
}
```

## 8. 입력 검증 규칙

각 `custom_match_id`는 반드시:
- 정확히 10개 player-game row
- 포지션별 정확히 2개 row (TOP × 2, JUG × 2, ...)
- 각 (custom_match_id, position) 조합마다 winner 1명 / loser 1명
- 같은 경기 내 `puuid` 중복 없음
- `position`, `game_team`, `game_result` 모두 정의된 enum 값

검증 실패 시 HTTP 400 + 에러 코드.

## 9. 에러 코드 (확정)

| HTTP | 코드 | 의미 |
|---|---|---|
| 400 | `MISSING_REQUIRED_COLUMN` | 필수 컬럼 누락 |
| 400 | `INVALID_MATCH_STRUCTURE` | 경기 row/포지션/승패 구조 오류 |
| 400 | `INVALID_POSITION` | enum 외 포지션 |
| 400 | `INVALID_GAME_TEAM` | enum 외 팀 |
| 400 | `INVALID_GAME_RESULT` | enum 외 승패 |
| 400 | `INVALID_BASELINE` | baseline 누락/형식 오류 |
| 400 | `INSUFFICIENT_USER_STATE` | 단일 경기 계산에 필요한 pre summary 부족 |
| 422 | `INSUFFICIENT_DATA` | baseline 계산용 데이터 부족 |
| 500 | `CALCULATION_FAILED` | 내부 계산 예외 |

응답 포맷:
```json
{
  "error_code": "INVALID_MATCH_STRUCTURE",
  "message": "each custom_match_id must contain 10 rows",
  "details": { "invalid_custom_match_ids": ["..."] }
}
```

## 10. MMR 산식 (v1 확정)

### 10.1 기본 설정
```python
INITIAL_MMR = 1300
BASE_WIN = 20
BASE_LOSS = -15
MMR_MIN_CHANGE = -25
MMR_MAX_CHANGE = 30
MMR_K_DECAY_START = 1500
MMR_K_DECAY_RATE = 0.002
MMR_K_MIN = 0.35
ALPHA = 0.6   # 개인 기여도
BETA  = 0.4   # 상대 비교
GAMMA = 0.2   # ELO 기대 대비 실제
WIN_FLOOR  = +12   # 의도된 floor (내전 변동 최소값)
LOSS_FLOOR = -12   # 의도된 floor
```

WIN/LOSS floor 12/-12는 의도된 정책이다. 내전 특성상 변동이 너무 작으면 사용자가 체감 못함. 향후 조정 시 이 문서에서 명시.

### 10.2 계산 순서 (각 경기당)
1. 경기 시작 시점의 (puuid, position)별 pre_pos_mmr snapshot
2. 각 row마다:
   - 같은 포지션 상대(opponent) pos_mmr 조회
   - `expected_score = 1 / (1 + 10^((opp_mmr - my_mmr)/400))`
   - `actual_score = game_impact_vs_opponent / 100` (NaN이면 expected)
   - `relative_factor = actual / expected` (clip 0.5~2 후 가져옴)
   - `personal_factor = (f1^ALPHA) * (f2^BETA)`
     - `f1 = game_n_person_contribution / mmr_baseline.f1_mean`
     - `f2 = game_impact_vs_opponent / mmr_baseline.f2_mean`
     - 각 [0.5, 2] clip
   - `final_factor = personal_factor * relative_factor^GAMMA`
   - `k = max(K_MIN, 1 - max(0, (current_mmr - K_DECAY_START) * K_DECAY_RATE))`
   - 승: `delta = clip(max(BASE_WIN * final_factor * k, WIN_FLOOR), WIN_FLOOR, MAX_CHANGE)`
   - 패: `delta = clip(min(BASE_LOSS * final_factor * k, LOSS_FLOOR), MIN_CHANGE, LOSS_FLOOR)`
3. `post_pos_mmr = pre_pos_mmr + delta`
4. `total_mmr`은 (포지션별 pos_mmr × pos_games) / Σpos_games 가중 평균

### 10.3 산식 일관성 (RECALC ↔ Incremental)
RECALC도 incremental과 동일하게 **저장된 `game_impact_baseline`을 `apply_game_impact_baseline`으로 적용**해야 한다. 즉 RECALC도 baseline 입력이 필수다.

- ❌ "데이터 들어왔으니 RandomForest를 다시 학습해서 적용"
- ✅ "BASELINE job에서 학습한 position_weights/outcome_stats를 그대로 RECALC에 적용"

이 일관성이 깨지면 RECALC 직후와 incremental 누적 결과가 다르게 나옴(현재 코드의 잠재 버그).

## 11. Baseline 산정 정책

### 11.1 산정 시점
| 시점 | 트리거 |
|---|---|
| 시즌 시작 | 백엔드가 BASELINE job 생성 → 운영자 승인/자동 |
| 운영자 갱신 | `/admin/mmr/baseline` |
| **매 incremental마다는 갱신하지 않는다.** | |

### 11.2 데이터 부족 처리
- 최소 경기 수 (기본 200) 미달 → `INSUFFICIENT_DATA` 422 응답
- 백엔드는 해당 시즌의 `guild_mmr_state.status = error` 또는 `wait_init` 유지 + 관리자 알람

### 11.3 baseline payload 구조 안정성
- `mmr_baseline`: `{ f1_mean, f2_mean }` (현재 v1) — 향후 확장 가능하되 키 추가만, 제거 금지
- `game_impact_baseline.position_weights`: `{ position: { metric: weight } }` 중첩 dict
- `game_impact_baseline.outcome_stats`: `[ { position, game_result, lower, upper } ]` 배열

## 12. MMR 서비스 내부 구조 (현재 코드 → 목표)

### 12.1 모듈 책임 (rename 후 동일)
```
src/mmr_refactor/
├── api_server.py        FastAPI 진입점 — endpoint 3개
├── service.py           HTTP layer ↔ pandas pipeline 어댑터
├── silver.py            기본 정제 (이름은 유지, 의미는 동일)
├── features.py          파생 feature 생성 (BASE_METRICS는 contract 컬럼 기반)
├── game_impact.py       Game Impact 계산 (RF 학습은 baseline에서만)
├── baseline.py          Baseline 산출/직렬화
├── mmr.py               ELO 기반 MMR 갱신
├── data_loader.py       (선택) DB→DF 로더
└── data_writer.py       (선택) DF→DB 라이터
```

### 12.2 변경 필요한 부분 (코드 작업 시 가이드)

1. **모든 컬럼명을 3장 표대로 일괄 rename**
2. `mmr.py:_apply_mmr_game`의 응답 컬럼명을 `pre_game_mmr`, `post_game_mmr`로
3. `service.calculate_full_mmr` → baseline 필수 인자로 강제 (None 경로 제거)
4. `service.calculate_single_match_mmr` → request key를 `mmr_baseline`, `pre_match_user_summary`로
5. `service._runtime_state_from_payload` → `pre_match_user_summary` 포맷에 맞춰 다시 작성
6. `game_impact.compute_raw_game_impact` 벡터화 (`df[metrics].values @ weights_matrix`)
7. `features.add_basic_features`의 NaN→0 fillna 제거 또는 metric별 정책 명시
8. `features.BASE_METRICS` 재정의 (분당 metric은 `time_played / 60`으로 계산)
9. `silver.clean_match_data`의 `game_duration` 처리 제거 (이제 `time_played` 사용)

### 12.3 응답에 `match_results` 외 포함되어야 할 것
- `user_summary` (RECALC) / `updated_user_summary` (incremental): **포지션별 포함 필수**
- `mmr_history`: 백엔드 저장용. position, before/after_pos_mmr 모두 포함

## 13. 배포 / 운영

### 13.1 인스턴스
- 별도 인스턴스 (Lightsail 2GB 권장, 처음엔 1GB 가능)
- FastAPI + uvicorn (`--workers 1`, `--limit-max-requests 200`)
- 메모리 사용량 모니터: baseline 학습 시점에 스파이크 ↑

### 13.2 런타임 의존성
```
fastapi>=0.110
uvicorn[standard]>=0.27
pandas>=2.0
numpy>=1.24
scikit-learn>=1.3
psycopg2-binary>=2.9   # (DB 모드 사용 시)
python-dotenv>=1.0
```

`matplotlib`, `seaborn`, `statsmodels`, `koreanize-matplotlib`, `openpyxl`은 **런타임에서 제거**.
필요 시 `requirements-dev.txt` 분리.

### 13.3 헬스체크
- `GET /health` → 200 OK, payload `{ "status": "ok", "version": "...", "uptime_seconds": ... }`
- 백엔드 worker에서 매 incremental 호출 전에 사전 ping (선택)

### 13.4 인증 (서비스 간)
- 백엔드 ↔ MMR 서비스 통신은 내부망 가정. 그래도 정적 헤더 시크릿 1개 권장.
- `Authorization: Bearer <SERVICE_TOKEN>` 또는 `X-Service-Secret: ...`

## 14. 통합 테스트 (양 레포 공통)

**같은 JSON pair**를 양쪽 CI에 박는다.

```
fixtures/
  baseline_calculate_request.json
  baseline_calculate_response.json
  recalculate_request.json
  recalculate_response.json
  matches_calculate_request.json
  matches_calculate_response.json
```

- 백엔드: payload 빌더 결과 == `*_request.json` 단언
- MMR 서비스: `*_request.json` 입력 시 응답이 `*_response.json` schema 부합 단언

이 fixture는 양 레포에서 동일 파일을 유지(서브모듈 또는 복사 + CI 동기 체크).

## 15. 마이그레이션 / 작업 순서 (MMR 서비스 측)

1. 3장 컬럼명 일괄 rename + 테스트 통과
2. `MMRSettings.positions`를 `("TOP", "JUG", "MID", "ADC", "SUP")`로 변경
3. 응답 컬럼명 변경 (`pre_game_mmr`, `post_game_mmr`)
4. `service.calculate_single_match_mmr` request schema 변경 + `pre_match_user_summary` 처리
5. `user_summary` / `updated_user_summary` 응답에 포지션별 항목 추가
6. baseline `INSUFFICIENT_DATA` 422 응답 도입
7. RECALC에서 baseline 필수화 (None 경로 제거)
8. `compute_raw_game_impact` 벡터화
9. requirements 슬림화
10. `/health` 응답 보강
11. fixture pair 추가 + CI 연결
12. (선택) 응답 NDJSON 스트리밍 v2 검토

## 16. 책임 정리 (양 레포)

### 백엔드 책임 (이 문서 외 `MMR_BACKEND_DESIGN.md` 참고)
- 리플레이 → metric 정제
- `is_mmr_eligible` 판정
- baseline 저장 / active baseline 관리
- MMR 서비스 호출
- 결과 저장 (`match_mmr_result`, `mmr_history`, `player_mmr_summary`)
- job queue / worker
- 소프트 딜리트 / cleanup

### MMR 서비스 책임 (이 문서)
- payload 검증
- Game Impact / baseline 계산
- 단일 경기 incremental 계산
- 전체 RECALC 계산
- `mmr_history` 항목 생성 (저장은 백엔드)
- DB 직접 접근 없음 (백엔드가 모든 데이터 주입)

## 17. 비기능 요구

| 항목 | 목표 |
|---|---|
| 단일 경기 응답 시간 | < 500ms (p95) |
| RECALC 응답 (1000경기) | < 30s (p95) |
| baseline 계산 (5000경기) | < 60s |
| 메모리 사용 (idle) | < 250MB |
| 메모리 사용 (RECALC) | < 800MB |
| 가용성 | 99% (월 ~7시간 다운타임 허용) |

## 18. 향후 (v2 후보, 현재 결정 보류)

- 응답 NDJSON 스트리밍
- 포지션별 가중치 자동 업데이트 (현재는 baseline 갱신 시에만)
- 챔피언 보정 factor
- 다중 worker / 큐 시스템 (Celery 등)
