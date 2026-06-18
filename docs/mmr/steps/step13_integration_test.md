# step13 — 통합 테스트 + contract fixture

> 상위 문서: [03_api_contract.md](../03_api_contract.md) (전체) | 전 step
> 선행: step01~12 | **마지막 step**

---

## 1. 목적 / 범위

MMR 파이프라인을 **gmok_mmr를 모킹**해 통합 검증하고, 양 레포가 공유하는 **contract fixture**(요청/응답 표준 예시)를 고정한다.

- 테스트 프레임워크: **Jest + ts-jest**(레포 기존, `src/test/`).
- gmok HTTP는 모킹 — `mmrClient`를 mock하거나 `fetch`를 가로채 fixture 응답 반환.
- 핵심: 업로드→metric→queue→worker→(mock gmok)→저장→조회의 **end-to-end**, 그리고 **멱등성·eligible·구독** 경계.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/test/fixtures/mmr/*.json` | 신규 — contract fixture (요청/응답) |
| `src/test/mmr/*.test.ts` | 신규 — 단위·통합 테스트 |

---

## 2. Contract fixture (양 레포 공유 SoT)

[03 §4, §5](../03_api_contract.md)의 표준 예시를 JSON으로 고정한다. **loltrix와 gmok_mmr이 같은 fixture로 테스트**하면 계약 드리프트를 잡는다.

| 파일 | 내용 |
|---|---|
| `match_calc.request.json` | `/v1/mmr/matches/calculate` 요청 (10 row + pre_match_user_summary + baseline) |
| `match_calc.response.json` | 그 정상 응답 (match_results/updated_user_summary/mmr_history) |
| `baseline_calc.request.json` | `/v1/mmr/baselines/calculate` 요청 |
| `baseline_calc.response.json` | 그 정상 응답 |
| `errors/*.json` | 400/422 에러 바디 예시 |

> fixture의 필드·타입·snake_case가 [03 계약](../03_api_contract.md)과 어긋나면 둘 중 하나가 틀린 것. gmok 팀에 동일 파일 제공(또는 공용 저장소).

---

## 3. 단위 테스트

| 대상(step) | 검증 |
|---|---|
| `judgeIsMmrEligible` (step03) | 5분 미만·AFK→false, 정상→true |
| `isMatchEligibleForMmr` (step03) | 10명·5포지션×2 정상→true, 구조 깨짐/9명→false |
| `buildMetricRows` (step03) | rawData+mp 매칭, PUUID 정합, game_result 1/0, 전용필드 0 fallback |
| `mmrClient` 에러 분류 (step06) | 400/422→`MmrContractError`, 5xx/timeout→`MmrServiceError`, 정상→파싱 |
| `buildSummaryRow` (step09) | positions→평면 15컬럼, 미플레이 포지션 1300/0/0 |
| `pickNextJob` 동시성 (step05) | 같은 길드 run 중이면 픽업 안 됨, SKIP LOCKED 중복픽업 없음 |
| `saveBaseline`/`activate` (step04) | 시즌 active 1개 partial unique, 전환 시 기존 해제 |

---

## 4. 통합 테스트 (mock gmok)

```
[T1] 업로드(구독 길드, 정상 10명)
  → mmr_participant_metric 10행, mmr_match_queue=wait

[T2] 업로드(부적격: 1명 5분 미만 / 또는 포지션 구조 깨짐)
  → metric 10행(is_mmr_eligible 반영), mmr_match_queue=skip

[T3] 업로드(비구독 길드)
  → metric·queue 미생성(통계만)

[T4] worker tick (mock gmok = match_calc.response fixture)
  → processMatch → save: mmr_match_result 10, mmr_history 10, mmr_member_summary upsert, queue=done

[T5] 멱등: 같은 경기 save 재호출(가드)
  → queue 이미 done → no-op, mmr_history 중복 INSERT 없음 (count 동일)

[T6] baseline 없음 상태에서 tick
  → no-op, queue=wait 유지(fail 아님)

[T7] gmok 5xx (mock) → MmrServiceError
  → 잡 markFail, attempts<3 재시도; 3회 초과 fail

[T8] gmok 400 (mock) → MmrContractError
  → 그 경기 mmr_match_queue=fail, 잡은 계속(done)

[T9] 구독 시작
  → guild_subscription=active, mmr_guild_state=wait_init, RECALC job enqueue

[T10] 해지
  → cancelled+ended_date, mmr_member_summary is_deleted=true
  → 이후 업로드 metric·queue 미생성

[T11] 조회 게이트
  → 비구독: available=false/inactive
  → wait_init: available=false/wait_init
  → ready: available=true + 데이터(개인/리더보드/이력)

[T12] RECALC 멱등 재시작
  → 일부 처리 후 재실행 시 summary 초기화부터 전량, 결과 동일 수렴

[T13] CLEANUP
  → (A) 해지 길드(유예 없음): summary/result/history/queue 삭제, metric 보존
  → (B) 삭제 경기(is_deleted=true) 30일 경과분: metric/queue/result/history 삭제
```

---

## 5. 테스트 인프라

| 항목 | 방식 |
|---|---|
| gmok 모킹 | `jest.mock('mmrClient')` 또는 fetch 인터셉트 → fixture 반환 |
| DB | 테스트 DB(로컬/CI) + **테스트별 트랜잭션 롤백** 또는 truncate. 기존 `src/test` 패턴 따름 |
| 시간 | `played_date`·`create_date`·딜레이(60분)·grace(30일)는 시간 의존 → fake timer 또는 `create_date` 주입으로 경계 테스트 |
| nanoid | calculation_id는 매번 달라짐 → 단언은 형식(`/^MMR-\d{8}-/`)·존재로 |
| 멱등 | 같은 fixture 2회 저장 후 row count 단언 |

---

## 6. 완료 기준 (DoD)

- [ ] contract fixture 4종 + 에러 예시, 03 계약과 일치
- [ ] 단위 테스트 §3 전부 통과
- [ ] 통합 T1~T13 통과
- [ ] 멱등(T5)·재시도(T7)·계약에러(T8)·RECALC 멱등(T12) 명시 검증
- [ ] `npm test`(jest) 그린
- [ ] fixture를 gmok 팀과 공유 가능한 형태로 보관(경로 문서화)

---

## 7. 의존성

- **선행**: step01~12 전부 (파이프라인 완성 후 통합 검증)
- gmok_mmr은 같은 contract fixture로 자기 쪽 검증 → 양방향 계약 보장
</content>
