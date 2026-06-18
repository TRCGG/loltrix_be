# MMR 시스템 개요

> **읽는 순서**: 이 문서를 먼저 읽고 → [01_architecture.md](./01_architecture.md) → [02_data_model.md](./02_data_model.md) → [03_api_contract.md](./03_api_contract.md) → steps/
>
> 컬럼·스키마·API 시그니처 같은 구체 설계는 각 문서와 steps/에 분리해 두었다.

---

## 1. 서비스 컨텍스트

**loltrix_be**는 롤(LoL) 내전 전적 검색 서비스의 백엔드다.

- 운영 단위: **디스코드 길드(서버)** = 한 내전 커뮤니티
- 유저가 게임 클라이언트에서 받은 **리플레이 파일**을 업로드하면, 백엔드가 파싱해 경기·참가자·통계를 보관·조회한다
- 현재 운영 중인 기능: 통계 화면, 챔피언별 승률, 길드원 랭킹

**MMR(Match Making Rating)** 은 이 위에 올라타는 유료 구독 기능이다.

---

## 2. 왜 MMR인가

| 문제 | 기존 상황 | MMR이 해결하는 것 |
|---|---|---|
| "누가 잘하는지" 정량 지표 없음 | 솔로랭크 티어는 내전 실력을 못 보여줌 | 내전 판 수·기여도 기반 점수 자동 산출 |
| 밸런스 팀 구성 근거 없음 | "느낌상" 비슷하게 나눔 → 기울어진 게임 | 포지션별 MMR로 팀 구성 가이드 |
| 개인 성장 추적 불가 | 한 시즌 동안 늘었는지 알 수 없음 | 경기마다 MMR 변동 히스토리 기록 |

### 통계 vs MMR

| | 통계 | MMR |
|---|---|---|
| 대상 | **모든 길드** (무료) | **구독 길드만** (유료) |
| 내용 | 승률·KDA·챔피언 픽률 등 사실 집계 | 산식 기반 점수 |
| 원천 데이터 | `match_participant` | `mmr_participant_metric` |

조회 원천이 다르다 — 통계는 `match_participant`, MMR은 `mmr_participant_metric`. `mmr_participant_metric`은 **모든 길드 경기에 생성**되는 정제 테이블이지만, **MMR 계산(점수 산출)은 구독 길드만** 대상이다. **MMR 계산에 부적합한 경기**(`is_mmr_eligible=false`)도 통계에는 포함된다.

---

## 3. 핵심 사용자 시나리오

### 3.1 MMR 구독 시작 (관리자 수동 API 호출)

구독 시작은 관리자가 대상 길드를 지정해 API를 직접 호출한다. (추후 웹 UI 연동 예정)

```
1. 관리자: POST /mmr/subscribe 호출 (body: guildId)
2. 백엔드: mmr_guild_state = wait_init, RECALC 작업을 **다음 오전 10시 KST로 예약**
3. 다음 오전 10시 → worker가 RECALC 실행 (비동기)
     ① mmr_member_summary 초기화 (MMR=1300)
     ② eligible 경기를 played_date ASC 순으로 incremental 반복
4. 완료 → mmr_guild_state = ready, 길드원 전원 MMR 조회 가능
```

> 구독 시점 이전의 경기까지 소급 계산된다. **다음 오전 10시부터** 시작하며, 1년치(수천 경기)면 20분+ 걸린다(경기 순서 의존이라 병렬 불가). 그때까지 "계산 중(wait_init)".

---

### 3.2 평소 운영 (매 경기 업로드 시)

```
1. 누군가 리플레이를 업로드
2. 백엔드: 경기·참가자·통계를 평소처럼 저장
3. 백엔드: MMR 구독 길드면
     - raw_data 파싱 → mmr_participant_metric 생성
     - mmr_match_queue = wait (MMR 계산 없음)
4. ⏱ 업로드 후 1시간 경과 시 worker 처리 대상이 됨
     (1시간 여유: 잘못 올린 리플 삭제 기회 + 불필요한 RECALC 방지. config `MMR_PROCESS_DELAY_MINUTES`, 기본 60)
5. worker가 wait 경기를 길드별·played_date 순으로 MMR 서비스에 순차 전송
6. 결과(개인별 MMR 변동·새 MMR) DB 저장, 경기 상태 done 전환
7. 유저가 다음 새로고침에서 변동 MMR 확인
```

업로드 시점에 MMR 계산을 직접 호출하지 않는다.
**업로드는 가볍게, 계산은 1시간 뒤 묶어서** — 이것이 핵심 원칙이다.

---

### 3.3 리플레이를 삭제하면

> **삭제 가능 기간**: 업로드 후 **2주 이내**만 삭제 가능(config `REPLAY_DELETE_WINDOW_DAYS`=14, system_config로 조정). 2주 지난 경기는 삭제 불가 → 역산 롤백의 누적 오차가 작게 묶인다.

리플 삭제는 **soft delete**다 — 경기·MMR 데이터를 `is_deleted=true`로 표시(복구 없음, 30일 후 cleanup이 hard delete).

| 삭제 대상 | 처리 |
|---|---|
| `wait` 상태 경기 (아직 MMR 미반영) | MMR 데이터(metric·queue) `is_deleted=true`. summary 영향 없음(미반영). |
| `done` 상태 경기 (이미 MMR 반영됨) | **① 역산 롤백** — `mmr_history`(현재 `mmr_delta`)와 `mmr_match_result` 조인(`game_result`)으로 `mmr_member_summary`를 되돌림(pos_mmr·games·wins 차감, total 재계산). **② soft delete** — 그 경기의 `metric`/`queue`/`result`/`history`를 `is_deleted=true`. **전체 RECALC 없음.** |

**역산 롤백을 쓰는 이유**:
1. 삭제가 **2주 이내**로 한정돼, 삭제 경기 이후 경기가 적어 역산 오차가 작음(허용 범위)
2. 전체 RECALC보다 가볍고 즉시 반영 — "지웠는데 MMR 그대로"가 없음
3. RECALC는 구독·재구독 같은 큰 이벤트에만 한정(운영 단순화)

---

### 3.4 시즌이 바뀌면

- 시즌 전환(새 시즌 시작·`season` 값 부여)은 **관리자가 수동으로 트리거**한다. 자동 롤오버 없음.
- 새 시즌의 MMR은 **초기화(1300)** 된다. 이전 시즌 점수는 조회만 가능.
- 새 시즌 baseline을 계산해야 한다. 충분한 경기 데이터가 쌓인 후 관리자가 수동으로 baseline 계산 API를 호출.
- baseline 계산 전까지는 새 시즌 MMR 계산 불가 (경기는 `wait` 상태로 대기).
- 이전 시즌 데이터는 그대로 보관·조회 가능.
- **시즌 중 baseline을 재계산해도 과거에 계산된 MMR은 그대로 유지**된다. 자동 RECALC 없음. 신규 경기만 새 active baseline을 적용한다.

---

### 3.5 구독을 해지하면

```
구독 해지 → summary is_deleted=true로 리더보드 즉시 숨김 (유예 없음)
  ├─ 재구독 → 전체 RECALC(다음 오전 10시 예약)로 metric에서 재구축 → 복원
  └─ 다음 CLEANUP → MMR 데이터 hard delete (metric은 전 길드 보존)
```

통계 데이터(`match_participant`)는 영향받지 않는다. 무료 통계는 계속 보인다.

---

## 4. 시스템 구성

```
┌─────────────────────┐  리플레이 업로드   ┌──────────────────────────┐
│  웹 / 디스코드 클라이언트 │ ─────────────▶ │  loltrix_be              │
└─────────────────────┘                  │  (이 레포)               │
         ▲                               │                          │
         │ MMR 조회 결과                   │  · DB 저장               │
         └─────────────────────────────── │  · incremental worker    │
                                         │  · daily cron            │
                                         │  · 구독 관리             │
                                         └───────────┬──────────────┘
                                                     │ HTTP (계산 요청만)
                                                     ▼
                                         ┌──────────────────────────┐
                                         │  gmok_mmr                │
                                         │  (별도 인스턴스)          │
                                         │  · FastAPI               │
                                         │  · MMR 산식              │
                                         │  · baseline 학습          │
                                         │  · **stateless**         │
                                         └──────────────────────────┘
```

### 역할 분리

| | loltrix_be (이 레포) | gmok_mmr (별도 레포) |
|---|---|---|
| 책임 | 데이터의 주인. 리플레이 보관, 통계, 구독 상태, MMR 결과 저장, 워커 운영 | 순수 계산기. 입력을 받아 결과를 돌려줌 |
| DB 접근 | O | X (완전 stateless) |
| 언어/스택 | TypeScript / Node.js | Python / FastAPI |

**분리한 이유**:
- MMR 계산은 numpy·pandas·scikit-learn이 필요 → 메모리 격리
- 백엔드 메인 프로세스가 계산 부하를 같이 받으면 사용자 응답 지연
- 계산 로직만 독립적으로 배포·재시작·롤백 가능

---

## 5. 핵심 데이터 흐름

```
[리플레이 업로드]
        │
        ▼
[replay 저장] ─── raw_data 보관
        │
        ▼
[custom_match 저장]
        │
        ▼
[match_participant 저장]          ← 통계는 여기까지. 모든 길드 동일.
        │
        ▼
[raw_data 파싱 → mmr_participant_metric 생성]   ← 모든 길드 (통계/MMR 공통)
        │   · is_mmr_eligible 판정
        │     (5분 미만·AFK 의심·비정상 포지션 구조 → false)
        │
        ▼
[MMR 구독 길드?] ──── 아니오 ────▶ 끝 (metric만 적재, MMR 계산 안 함)
        │ 예
        ▼
[mmr_match_queue = wait]  ← "아직 MMR 미반영"
        │
        │  ⏱ 업로드 후 1시간 경과 시 처리 대상
        │    (cron worker가 주기적으로 확인)
        ▼
[wait + 1시간 경과 경기를 길드별·played_date asc 순으로 묶음]
        │
        ▼
[MMR 서비스 호출: 단일 경기 incremental]
        │   입력: 경기 10명 row + 현재 포지션별 MMR state
        │   출력: 새 MMR·변동량·사유
        │
        ▼
[mmr_match_result + mmr_history + mmr_member_summary 갱신] ← 단일 트랜잭션
        │
        ▼
[mmr_match_queue = done]
```

---

## 6. 용어 정의

| 용어 | 설명 |
|---|---|
| **길드(guild)** | 디스코드 서버 = 내전 커뮤니티 한 단위. MMR 구독·집계의 기본 단위. |
| **시즌(season)** | MMR을 누적하는 기간 (보통 1년). 새 시즌이 되면 baseline부터 다시. |
| **리플레이(replay)** | 게임 클라이언트가 만든 한 판의 원본 기록 파일. |
| **custom_match** | 리플레이 1개에서 파싱된 "한 경기". |
| **match_participant** | 한 경기의 참가자 10명 각각의 row (챔피언·팀·승패 등). |
| **mmr_participant_metric** | 정제된 참가자 row(통계/MMR 공통 입력). **모든 길드 경기에 생성**, MMR 계산은 구독 길드만. raw_data에서 필요한 필드를 추출·표준화. |
| **is_mmr_eligible** | 이 row가 MMR 계산에 쓰여도 되는지 (true/false). 경기 내 1명이라도 false면 해당 경기 전체 MMR 제외. |
| **played_date** | 경기 플레이 시각. raw_data에서 추출(없으면 업로드 시각으로 fallback). incremental 처리 순서(ASC)의 기준. |
| **is_placed** | 배치 완료 여부. `total_games >= N`이면 true. false(배치 중)면 리더보드에서 분리 노출. |
| **baseline** | MMR·Game Impact 계산의 기준값. 시즌마다 한 번 학습. |
| **baseline_version** | 특정 baseline 계산 결과의 식별자. |
| **calculation_id** | 특정 계산 실행의 식별자. 멱등성·추적용. nanoid 기반 `MMR-{YYYYMMDD}-{nanoid}`. |
| **incremental** | 새 경기 한 건만 가산식으로 반영. 일상 운영의 메인 경로. |
| **RECALC** | 길드+시즌 전체를 처음부터 재계산. **구독·재구독 때만** (삭제는 역산 롤백, 시즌 변경은 baseline 수동). |
| **mmr_job** | 워커가 픽업할 작업 큐 row. `wait → run → done/fail` 흐름. |
| **mmr_member_summary** | 유저별 "현재 MMR"의 진실의 원천(SoT). incremental의 사전 상태로도 쓰임. |
| **mmr_history** | 경기마다 MMR 변동 시계열. monthly partition. |

---

## 7. 구독 상태 모델

모든 MMR 조회 API는 아래 포맷으로 응답한다.

```json
{
  "available": false,
  "status": "wait_init",
  "message": "MMR 초기 계산 진행 중입니다.",
  "data": null
}
```

| guild 상태 | available | 사용자 메시지 |
|---|---|---|
| 구독 없음 / cancelled | false | "이 길드는 MMR 기능을 사용하지 않습니다" |
| wait_init | false | "MMR 초기 계산 진행 중입니다" |
| ready | true | 실제 MMR 데이터 반환 |
| error | false | "일시적 처리 지연" (내부 알람 발송) |

> "구독 없음"은 `guild_subscription`에 active 행이 없는 경우, 나머지(`wait_init`/`ready`/`error`)는 `mmr_guild_state.status`다.

### 상태 전이 (mmr_guild_state)

```
(구독/재구독) ──▶ wait_init ──[RECALC 완료]──▶ ready
                    │                            │
                 [실패]                 [incremental 반복]
                    ▼                            │
                  error ──[재시도]──▶ wait_init  │
                                          (done 삭제는 역산 롤백 — 상태 변화 없음)
```

---

## 8. 운영 정책 결정표

| 항목 | 결정 | 이유 |
|---|---|---|
| 계산 방식 | 평소 incremental, RECALC는 예외만 | 매 업로드마다 전체 재계산 → 비용 과다 + 결과 불안정 |
| done 경기 삭제 시 | **즉시 역산 롤백**(mmr_history 기준). 전체 RECALC 없음 | 삭제 2주 제한으로 오차 작음. 즉시 반영. RECALC는 (재)구독만 |
| 리플 삭제 가능 기간 | 업로드 후 **2주 이내**(config `REPLAY_DELETE_WINDOW_DAYS`=14) | 역산 누적 오차를 작게 묶음 + 오래된 경기 보호 |
| 업로드 시 계산 | 즉시 계산 없음. 업로드 후 1시간 경과 시 worker가 처리 (config `MMR_PROCESS_DELAY_MINUTES`=60) | 업로드 응답 속도 보호 + 잘못 올린 리플 삭제 기회 확보 |
| 포지션별 state 저장 위치 | 백엔드 DB (`mmr_member_summary`) | incremental이 매 경기마다 "현재 포지션 MMR"을 알아야 함 |
| MMR 서비스 위치 | 별도 인스턴스 상시 가동 | 메모리 격리, 독립 배포, 백엔드 응답 보호 |
| MMR 부적격 경기 | 통계 포함, MMR만 제외 | "있었던 경기"라는 사실은 통계에 필요 |
| 비정상 포지션 구조 경기 | 업로드 시 `is_mmr_eligible=false`로 사전 제외 | 5포지션 정상 구조(TOP/JUG/MID/ADC/SUP ×2)가 아니면 계산 부적합. gmok_mmr 400·fail 노이즈 방지 |
| 시즌 중 baseline 변경 | 과거 계산 MMR 유지, 자동 RECALC 안 함. 신규 경기만 새 baseline | 과거 결과 안정성 우선 |
| RECALC 트리거 | **구독·재구독 시에만** | 삭제는 롤백, baseline 변경은 과거 유지 → 무거운 RECALC 최소화 |
| 판수 부족 유저 | `total_games < N`이면 배치 중(`is_placed=false`)·리더보드 분리 | 1~2판 유저가 1300으로 상위 노출되는 왜곡 방지 |
| 재구독 | 유예 없음 — 재구독 시 metric에서 전체 RECALC로 복원 | metric이 전 길드 보존되어 언제든 재구축 가능. 유예 보관은 이점 없음 |
| 데이터 부족 | `INSUFFICIENT_DATA` 명시 에러 | "조용히 0점" 같은 모호한 상태 방지 |
| mmr_history 파티션 | 처음부터 monthly range partition, 2년 보존 후 정리 | 시계열이라 1~2년 안에 폭증 예상. 나중에 쪼개기 어려움 |

---

## 9. 스코프 컷 (하지 않기로 한 것)

| 항목 | 이유 |
|---|---|
| 부계정 통합 | puuid 단위. 같은 사람이 두 puuid면 두 사람으로 처리 |
| 챔피언별 가중치 (v1) | 포지션까지만. v2 후보 |
| 외부 공개 API | 길드 내부 조회만 |
| MMR 변경 푸시 알림 (v1) | 다음 접속에서 확인 |
| 솔로랭크 티어 매핑 | 내전 전용 점수. 외부 랭크와 무관 |
| 유저 탈퇴 시 MMR 처리 | puuid 단위로 방치. 탈퇴해도 MMR row 유지(별도 삭제·익명화 안 함) |
| done 경기 삭제 시 전체 RECALC | 안 함. 역산 롤백으로 즉시 보정(2주 삭제 제한이 오차를 묶음) |

---

## 10. 문서 맵

| 문서 | 내용 |
|---|---|
| **이 문서** | 왜/무엇/어떻게 (개요) |
| [01_architecture.md](./01_architecture.md) | 아키텍처 결정사항, 컴포넌트 상세, 데이터 흐름도 |
| [02_data_model.md](./02_data_model.md) | 테이블 9종 스키마, 상태 머신, 인덱스 전략 |
| [03_api_contract.md](./03_api_contract.md) | 백엔드 ↔ MMR 서비스 통신 계약, payload 명세, 에러 코드 |
| [steps/step01_migration.md](./steps/step01_migration.md) | DB 마이그레이션 구현 스펙 |
| [steps/step02_schema.md](./steps/step02_schema.md) | Drizzle ORM 스키마 구현 스펙 |
| [steps/step03_metric_eligible.md](./steps/step03_metric_eligible.md) | mmr_participant_metric 정제 + is_mmr_eligible |
| [steps/step04_baseline.md](./steps/step04_baseline.md) | mmr_season_baseline 저장·조회·active 전환 |
| [steps/step05_job_queue.md](./steps/step05_job_queue.md) | mmr_job 큐 + worker 골격 |
| [steps/step06_mmr_client.md](./steps/step06_mmr_client.md) | gmok_mmr 클라이언트 (fetch) |
| [steps/step07_subscription.md](./steps/step07_subscription.md) | 구독 시작·해지·재구독 API |
| [steps/step08_incremental_worker.md](./steps/step08_incremental_worker.md) | 30분 incremental worker |
| [steps/step09_result_save.md](./steps/step09_result_save.md) | 결과 저장 (멱등 upsert + 트랜잭션) |
| [steps/step10_query_api.md](./steps/step10_query_api.md) | 조회 API (available/status/data) |
| [steps/step11_admin_api.md](./steps/step11_admin_api.md) | 운영자 API (baseline·경기 제외·job) |
| [steps/step12_crons.md](./steps/step12_crons.md) | daily cron (cleanup) + monthly partition cron |
| [steps/step13_integration_test.md](./steps/step13_integration_test.md) | 통합 테스트 (contract fixture) |
| [steps/step14_deletion_rollback.md](./steps/step14_deletion_rollback.md) | 리플 삭제 MMR 역산 롤백 (2주 제한·soft delete) |
