# MMR 아키텍처 설계

> 짝 문서: [00_overview.md](./00_overview.md) | [02_data_model.md](./02_data_model.md) | [03_api_contract.md](./03_api_contract.md)

---

## 1. 컴포넌트 구성

```
┌──────────────────────────────────────────────────────────┐
│  loltrix_be  (이 레포, Node.js / TypeScript)             │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐  ┌───────────────┐  │
│  │  API Layer  │   │  incremental │  │  daily cron   │  │
│  │  (Express)  │   │  cron worker │  │  (10시 KST)   │  │
│  └──────┬──────┘   │  (30분 주기) │  │   + 적체알람) │  │
│         │          └──────┬───────┘  └──────┬────────┘  │
│         │                 │                 │           │
│  ┌──────▼─────────────────▼─────────────────▼────────┐  │
│  │                   Service Layer                   │  │
│  │  mmrBaseline / mmrResult / subscription / ...     │  │
│  └──────────────────────────┬────────────────────────┘  │
│                             │                           │
│  ┌──────────────────────────▼────────────────────────┐  │
│  │                  PostgreSQL                       │  │
│  │  (경기·참가자·통계·MMR 결과·구독 상태 전부)          │  │
│  └───────────────────────────────────────────────────┘  │
│                             │                           │
│  ┌──────────────────────────▼────────────────────────┐  │
│  │            mmrClient (axios wrapper)              │  │
│  └──────────────────────────┬────────────────────────┘  │
└─────────────────────────────┼────────────────────────────┘
                              │ HTTP (내부망)
                              ▼
┌─────────────────────────────────────────────────────────┐
│  gmok_mmr  (별도 인스턴스, Python / FastAPI)             │
│                                                         │
│  POST /v1/mmr/baselines/calculate   ← baseline 학습     │
│  POST /v1/mmr/matches/calculate     ← 단일 경기 계산    │
│  GET  /health                                           │
│                                                         │
│  · stateless (DB 직접 접근 없음)                         │
│  · 엔드포인트 2개 (RECALC 전용 없음)                     │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 아키텍처 결정사항

### A. gmok_mmr 엔드포인트는 2개

gmok_mmr은 `baselines/calculate`와 `matches/calculate` **둘만** 노출한다. RECALC 전용 엔드포인트는 두지 않는다 — loltrix_be가 `mmr_member_summary`를 초기화한 뒤 `matches/calculate`를 경기 순서대로 반복 호출하는 것이 RECALC와 수학적으로 동일하기 때문이다.

**이유**:
- 단일 대용량 HTTP 요청 → 타임아웃·커넥션 드롭 위험 제거
- 실패 시 실패한 경기부터 재시작 가능 (부분 복구)
- gmok_mmr 코드베이스 단순화

---

### B. RECALC = player 상태 초기화 + incremental 반복

```
RECALC 실행 흐름:

1. mmr_member_summary 해당 길드+시즌 전체 초기화
   (total_mmr=1300, *_games=0, *_wins=0)

2. 해당 길드+시즌 경기를 played_date ASC 순으로 전부 조회
   (is_mmr_eligible=true인 경기만)

3. 경기 한 건씩 순회:
   a. 이 경기 10명의 현재 mmr_member_summary 조회
   b. POST /v1/mmr/matches/calculate 호출
   c. 결과를 mmr_match_result / mmr_history에 저장
   d. mmr_member_summary 갱신
   e. 다음 경기로

4. 완료 → mmr_guild_state.status = ready
```

500경기 기준 예상 시간: `500 × 200ms ≈ 100초`. 비동기 job으로 실행하므로 사용자 응답에 영향 없음.

---

### C. 삭제 처리: 역산 롤백 (전체 RECALC 없음)

리플 삭제는 **업로드 후 2주 이내**만 허용된다(config `REPLAY_DELETE_WINDOW_DAYS`=14). 경기 상태에 따라:

```
삭제 발생
  │
  ├─ wait 경기 (MMR 미반영) → mmr_match_queue=skip. 비용 0.
  │
  └─ done 경기 (MMR 반영됨) → 즉시 역산 롤백 + soft delete:
        1. 이 custom_match_id의 mmr_history(현재 delta) JOIN mmr_match_result(game_result) 조회
        2. 각 참가자 mmr_member_summary 역산:
             pos_mmr  -= mmr_delta
             pos_games -= 1,  pos_wins -= game_result
             total_mmr 재계산 (가중평균)
        3. 이 경기의 mmr_participant_metric / mmr_match_queue / mmr_match_result / mmr_history
           → is_deleted = true (soft delete, 복구 없음 → 영구 보존)
        ※ 전체 RECALC 없음, hard delete 없음
```

**역산이 허용되는 이유 (2주 제한이 핵심)**: 역산은 삭제 경기 이후 경기들을 보정하지 않아 수학적으로 완전하지 않다. 하지만 **삭제를 2주 이내로 한정**하면 삭제 경기 이후 경기 수가 적어 누적 오차가 작다(허용 범위). 전체 RECALC보다 가볍고 **즉시 반영**된다.

> `game_result`(pos_wins 역산용)는 `mmr_history`에 중복 저장하지 않고 `mmr_match_result_id`로 **조인**해 얻는다. delta는 history의 `mmr_delta`(현재 적용값).
> **soft delete**: 경기·MMR row는 모두 `is_deleted=true`로 표시(복구 없음, hard delete 없이 영구 보존).
> **RECALC는 (재)구독 시에만** — 삭제·baseline 변경엔 RECALC를 쓰지 않는다.

---

### D. Baseline: 시즌별 전체 길드 통합, 수동 트리거

```
- guild_id 없음. (season, baseline_version)이 식별자.
- 한 시즌에 baseline 1개 (is_active=true).
- 모든 길드가 같은 시즌 baseline을 공유.
- 자동 트리거 없음. 운영자가 POST /admin/mmr/baseline 호출 시에만 계산.
- 시즌 내 baseline 재계산 → 과거 계산 MMR은 그대로 유지. 자동 RECALC 없음. 신규 경기만 새 active baseline 적용.
  (RECALC는 (재)구독 시에만 — baseline 변경엔 수동 RECALC도 두지 않는다.)
```

**baseline 없는 상태에서 incremental 실행 시**: 경기를 `fail` 처리하지 않고 `wait` 유지. baseline이 생성되면 자동으로 다음 worker tick에서 처리된다.

---

### E. 동시성: mmr_job 큐 단일화

incremental·RECALC **비동기 작업을 `mmr_job` 큐 하나로 직렬화**한다. 별도 advisory lock이나 `mmr_guild_state` 행 잠금(NOWAIT)을 쓰지 않는다. (BASELINE은 관리자 수동·<60초라 큐에 넣지 않고 동기 admin API로 처리. CLEANUP은 soft-delete only로 제거.)

```sql
-- worker가 다음 잡을 픽업할 때 (요지)
UPDATE mmr_job SET status='run', started_date=NOW(), attempts=attempts+1
WHERE id = (
  SELECT id FROM mmr_job m
  WHERE m.status='wait' AND m.scheduled_date <= NOW()
    AND ( m.guild_id IS NULL
          OR NOT EXISTS (              -- 같은 길드의 누적 작업이 run 중이면 회피
            SELECT 1 FROM mmr_job r
            WHERE r.guild_id = m.guild_id AND r.status='run'
              AND r.job_type IN ('INCREMENTAL_BATCH','RECALC') ) )
  ORDER BY m.scheduled_date ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

- **`FOR UPDATE SKIP LOCKED`**: 여러 picker가 같은 잡을 두고 충돌하지 않는다.
- **per-guild `NOT EXISTS(run job)`**: 한 길드의 `INCREMENTAL_BATCH`/`RECALC`는 동시에 둘 이상 돌지 않는다(누적 순서 보장). 다른 길드 잡은 병렬 가능.
- (CLEANUP 잡은 제거됨 — soft-delete only. 남은 잡 `INCREMENTAL_BATCH`/`RECALC`는 모두 guild 단위라 per-guild 직렬화 적용.)
- 재시도·취소·실패 추적이 모두 `mmr_job` 한 곳에 모인다 → 관측·운영 단순.

> 길드 행 잠금(`FOR UPDATE NOWAIT`)이 아니라 **큐가 동시성을 책임진다** — 재시도·관측·취소가 한 곳에 모여 추론하기 쉽다.

---

## 3. 주요 흐름

### 3.1 리플레이 업로드

```
업로드 API
  │
  ├─ replay 저장 (raw_data 보관)
  ├─ custom_match 저장
  ├─ match_participant 저장
  │
  ├─ raw_data 파싱 → mmr_participant_metric 생성  ← 모든 길드 (통계/MMR 공통)
  │   + is_mmr_eligible 판정
  │
  └─ guild MMR 구독 active?
       ├─ 아니오 → 완료 (metric만 적재, MMR 계산 안 함)
       └─ 예 → mmr_match_queue = wait
               (MMR 계산 없음. 업로드 응답 즉시 반환)
```

---

### 3.2 incremental worker

```
cron tick (30분 주기)
  │
  └─ wait + 업로드 후 1시간 경과 경기 있는 길드 목록 조회
       (mmr_match_queue.create_date <= NOW() - interval '60 min',
        config MMR_PROCESS_DELAY_MINUTES=60)
       │
       └─ 길드별 INCREMENTAL_BATCH job 생성(enqueue) → mmr_job 큐로
            │
            worker가 픽업 (per-guild 직렬화는 §2-E 큐가 보장)
            │
            ├─ baseline 없으면 → 처리 보류, 경기 wait 유지 (다음 tick 재시도)
            │
            ├─ 조건 맞는 wait 경기를 played_date ASC로 1건씩 순회
            │    │
            │    ├─ mmr_match_queue FOR UPDATE + status=wait 재확인 (재처리 가드)
            │    ├─ 10명 mmr_member_summary 조회
            │    ├─ POST /v1/mmr/matches/calculate
            │    ├─ BEGIN TX
            │    │    UPSERT mmr_match_result
            │    │    INSERT mmr_history
            │    │    UPSERT mmr_member_summary
            │    │    UPDATE mmr_match_queue = done
            │    └─ COMMIT
            │
            └─ 잡 완료 → markDone
```

---

### 3.3 신규 구독 → RECALC

```
POST /mmr/subscribe  (body: guildId)
  │
  ├─ guild_subscription.status = active
  ├─ mmr_guild_state.status = wait_init
  └─ RECALC job 생성, scheduled_date = 다음 오전 10시 KST (무거워서 한산한 창으로 예약)
       │
       (다음 오전 10시) worker가 픽업
         │
         ├─ Step 1. mmr_member_summary 초기화
         │    해당 길드+시즌 전원 MMR=1300, games=0, wins=0, is_deleted=false
         │    (metric은 이미 모든 길드에 적재돼 있음 → raw 재파싱 backfill 불필요)
         │
         ├─ Step 2. incremental 반복
         │    is_mmr_eligible=true 경기를 played_date ASC 순으로 순회
         │    경기별 POST /v1/mmr/matches/calculate
         │    결과 저장 + mmr_member_summary 갱신
         │
         └─ 완료 → mmr_guild_state.status = ready
```

> **RECALC 재시도는 멱등**: job이 재시도되면 Step 1(summary 초기화)부터 전량 다시 실행한다(부분 갱신 오염 방지).
> **RECALC는 다음 오전 10시 KST 예약 실행**: 1년치 데이터면 20분+ 걸리는 무거운 작업(경기 순서 의존 → 병렬 불가)이라, 즉시 돌리면 worker가 다른 길드 incremental을 못 처리한다. 그래서 `scheduled_date`를 10시로 잡아 한산한 시간대(daily cron 창)에 몰아 처리. 그때까지 `wait_init`.

**재구독**: 해지 후 경과 기간과 무관하게 **신규와 동일한 전체 RECALC**(다음 10시 예약). 해지 때 숨겨진(soft-deleted) summary 위에 RECALC가 현재 시즌을 덮어쓴다([step07](./steps/step07_subscription.md)). hard delete가 없으므로 데이터는 그대로 보존(과거 시즌은 숨겨진 채 유지).

---

### 3.4 리플 삭제 → MMR 처리

```
DELETE /replays/:id   (soft delete)
  │
  ├─ 삭제 가능 기간(2주, REPLAY_DELETE_WINDOW_DAYS) 초과 → 거부
  ├─ custom_match / match_participant.is_deleted = true (기존)
  │
  └─ mmr_match_queue.status 분기:
       │
       ├─ wait → metric·queue.is_deleted=true. summary 영향 없음(미반영)
       │
       └─ done → 즉시 역산 롤백 (§2-C):
                  ① mmr_history(현재 delta) JOIN mmr_match_result(game_result)
                     → mmr_member_summary 역산(pos_mmr·games·wins 차감, total 재계산)
                  ② 이 경기 metric/queue/result/history.is_deleted=true (soft delete)
                  (전체 RECALC 없음, 복구 없음 → soft delete 영구 보존)
```

---

### 3.5 daily cron (오전 10시 KST)

```
1. monthly partition 다음달 분 미리 생성 (mmr_history)
2. 24시간 이상 wait인 custom_match 적체 알람
   (hard delete/CLEANUP 없음 — soft delete 영구 보존)
```

> daily cron 자체는 적체 알람만(파티션은 monthly cron, hard delete 없음). 삭제는 역산 롤백이라 RECALC 트리거 없음. 다만 **(재)구독 RECALC가 `scheduled_date=10시`로 예약돼 있어, 같은 10시 창에 worker가 그 RECALC들도 함께 픽업**한다 → 10시 = "무거운 배치 창"(RECALC).

---

## 4. gmok_mmr 책임 범위

```
loltrix_be가 준비:               gmok_mmr이 처리:
  - raw_data 파싱                  - payload 검증
  - mmr_participant_metric 생성  - Game Impact 계산
    (모든 길드)                     - ELO 기반 MMR 계산
  - is_mmr_eligible 판정           - mmr_history 항목 생성
  - baseline 저장·관리              - 응답 반환 (저장은 백엔드)
  - 경기 순서 보장
  - 결과 저장
  - 상태 관리 (job, guild state)
  - 동시성 제어
```

통계는 `match_participant`를 직접 사용. `mmr_participant_metric`은 통계·상대전적·MMR이 공유하는 정제 테이블(마이그레이션 007 소유). MMR 계산은 그 위에 얹는다.

gmok_mmr은 DB에 직접 접근하지 않는다. 매 요청이 독립적이며 상태를 보유하지 않는다.

---

## 5. 비기능 요구사항

| 항목 | 목표 | 비고 |
|---|---|---|
| 업로드 응답 시간 | 기존과 동일 (MMR 계산 없음) | 업로드와 MMR 계산 완전 분리 |
| incremental 단일 경기 처리 | < 1초 (gmok_mmr 응답 포함) | |
| RECALC (1년치 수천 경기) | 20분+ 허용 (경기 순서 의존 → 병렬 불가) | **다음 오전 10시 예약** 비동기. 사용자는 `wait_init`으로 대기 |
| gmok_mmr 단일 요청 응답 | < 500ms (p95) | |
| baseline 계산 | < 60초 | 수동 트리거, 운영자 대기 가능 |
| 인스턴스 | loltrix_be: Lightsail 1~2GB | gmok_mmr: 별도 Lightsail 1~2GB |

---

## 6. 인터페이스 요약 (→ 03_api_contract.md 상세)

| API | 호출 시점 | 비고 |
|---|---|---|
| `POST /v1/mmr/baselines/calculate` | 운영자 수동 | 시즌별 전체 길드 데이터 |
| `POST /v1/mmr/matches/calculate` | incremental / RECALC 공용 | 경기 1건, 10명 row |
| `GET /health` | worker 사전 ping (선택) | |

---

## 7. 결정 완료 항목

| 항목 | 결정 |
|---|---|
| mmr_job 테이블 | **유지.** incremental·RECALC가 큐 경유(§2-E). job_type 2종: `INCREMENTAL_BATCH`/`RECALC`. CLEANUP 제거(soft-delete only), BASELINE은 동기 admin API |
| 동시성 모델 | `mmr_job` 큐 단일화 (`SKIP LOCKED` + per-guild `NOT EXISTS`). `FOR UPDATE NOWAIT` 폐기 |
| done 삭제 보정 | **역산 롤백**(mmr_history 기준), 전체 RECALC 없음. 삭제는 2주 이내만 허용 |
| RECALC 트리거 | **(재)구독 시에만**. 삭제·baseline 변경엔 RECALC 안 함 |
| metric 생성 범위 | 모든 길드(통계/MMR 공통). MMR 계산만 구독 길드 |
| 처리 지연 | `MMR_PROCESS_DELAY_MINUTES` 기본 60분 (config) |
| baseline 시즌 중 변경 | 과거 MMR 유지, 자동 RECALC 없음 |
| 스케줄러 | **`node-cron`** 추가. 30분 incremental + daily(10시 KST, `Asia/Seoul`) + monthly 파티션 트리거를 한 의존성으로. 단일 인스턴스 가정 |
