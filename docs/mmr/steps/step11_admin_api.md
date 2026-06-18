# step11 — 관리자 API (baseline / 경기 제외 / job)

> 상위 문서: [03_api_contract §4](../03_api_contract.md) | [01_architecture §2-D](../01_architecture.md) | [00_overview §3.4](../00_overview.md)
> 선행: [step04](./step04_baseline.md) · [step05](./step05_job_queue.md) · [step06](./step06_mmr_client.md) | 다음: [step12_crons.md](./step12_crons.md)

---

## 1. 목적 / 범위

운영자가 수동으로 호출하는 관리 API 묶음.

1. **baseline 동기 계산** — 시즌 데이터 모아 gmok 호출 → 저장·활성화
2. **경기 수동 제외** — 특정 경기 MMR 제외(역산 롤백, replay는 유지)
3. **job 관리** — 목록/취소/재시도

> RECALC 수동 트리거는 **없다** — RECALC는 (재)구독 시에만.

> 권한 게이트·`decodeGuildId` **없음**([API 컨벤션](../00_overview.md)). guildId는 body/parameter로 받되 비-GET은 디코딩 안 함. (운영 도구·내부 호출 전제.)

### 산출물

| 파일 | 변경 |
|---|---|
| `src/routes/mmrAdmin.routes.ts` | 신규 |
| `src/controllers/mmrAdmin.controller.ts` | 신규 |
| `src/services/mmrAdmin.service.ts` | 신규 — baseline 오케스트레이션, 경기 제외(역산 롤백) |
| `src/routes/index.ts` | 등록 |

---

## 2. 엔드포인트

| 메서드 | 경로 | body | 설명 |
|---|---|---|---|
| POST | `/api/mmr/admin/baseline` | `{ season?, minMatchCount? }` | baseline 동기 계산·저장·활성화 |
| POST | `/api/mmr/admin/matches/:customMatchId/exclude` | — | 경기 MMR 제외 (역산 롤백) |
| GET | `/api/mmr/admin/jobs` | query `status?/jobType?/guildId?` | job 목록 |
| POST | `/api/mmr/admin/jobs/:jobId/cancel` | — | job 취소 |
| POST | `/api/mmr/admin/jobs/:jobId/retry` | — | job 재시도 |

> `GET /jobs`에서 `guildId` 필터를 쓰면 GET이라 `decodeGuildId` 적용(base64). `:jobId`는 숫자(serial). cancel/retry는 POST.

---

## 3. baseline 동기 계산 (핵심)

[step04](./step04_baseline.md)의 저장 서비스 + [step06](./step06_mmr_client.md)의 gmok 호출을 **동기로** 엮는다([01 §2-D](../01_architecture.md): baseline은 큐 안 거치고 admin이 직접).

```
POST /api/mmr/admin/baseline { season?, minMatchCount? }
  season = body.season ?? LOL_SEASON
  baselineVersion = 생성 ("YYYY-MM"; 같은 달 재계산 충돌 시 시각 suffix)
  minMatchCount = body.minMatchCount ?? 기본(예: 200)

  1) 시즌 전체 길드의 적격 player-game row 수집
       SELECT ... FROM mmr_participant_metric m
       JOIN mmr_match_queue q ON q.custom_match_id = m.custom_match_id
       WHERE m.season = $season AND m.is_mmr_eligible = TRUE AND m.is_deleted = FALSE
         AND q.status <> 'skip' AND q.status <> 'fail'        -- 정상 경기만
       → PlayerGameRow[] : metric→interface 변환 적용([step08 §5](./step08_incremental_worker.md) 재사용)
         = 필드명 리네임(kills→kill 등) + match_participant_id join(metric 미보유)

  2) gmok 동기 호출 (타임아웃 60s)
       res = mmrClient.calculateBaseline({ season, baseline_version, min_match_count, matches })

  3) 저장 + 활성화
       mmrSeasonBaseline.saveBaseline({
         season, baselineVersion,
         mmrBaseline: res.mmr_baseline, gameImpactBaseline: res.game_impact_baseline,
         metadata: { match_count: res.metadata.match_count, row_count: res.metadata.player_game_row_count },
         activate: true,
       })
  → 200 { season, baselineVersion, match_count, row_count }
```

**에러**:
- `MmrContractError(422, INSUFFICIENT_DATA)` → 그대로 422 반환(경기 수 부족). baseline은 전역이라 길드 상태 변경 없음.
- `MmrContractError(400)` → 400(필수 컬럼/구조 오류 — 데이터 정합성 점검 필요).
- `MmrServiceError` → 503(gmok 장애, 재시도 안내).

> baseline 재계산해도 **과거 MMR은 유지**([00 §3.4](../00_overview.md)). **수동 RECALC는 없다** — RECALC는 (재)구독 시에만 발생한다.

---

## 4. 경기 수동 제외 ([step03](./step03_metric_eligible.md) eligible 4번)

운영자가 특정 경기를 MMR에서 빼고 싶을 때(어뷰징·비정상 등). **리플 삭제([step14](./step14_deletion_rollback.md))와 같은 역산 롤백 메커니즘** — 단 replay는 지우지 않고 MMR만 제외한다.

```
POST /api/mmr/admin/matches/:customMatchId/exclude
  q = mmr_match_queue(customMatchId)
  ├─ wait → 이 경기 metric·queue.is_deleted=true   (미반영 → summary 영향 없음)
  └─ done → ① 역산 롤백(step14와 동일: history+result 조인 → summary 차감)
            ② 이 경기 metric/queue/result/history.is_deleted=true
  (replay/custom_match은 유지 — MMR만 제외)
  → 200
```
> **RECALC 수동 트리거는 없다** — done 경기 제외도 역산 롤백으로 즉시 처리(전체 RECALC 없음).

---

## 5. job 관리 ([step05](./step05_job_queue.md) 서비스 노출)

```
GET  /api/mmr/admin/jobs?status=&jobType=&guildId=   → mmrJobService.listJobs(filter)
POST /api/mmr/admin/jobs/:jobId/cancel               → cancelJob (wait/run만, 아니면 409)
POST /api/mmr/admin/jobs/:jobId/retry                → retryJob (fail/cancel만, attempts=0 리셋)
```
운영 화면에서 적체·실패 잡 확인·조치용.

---

## 6. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| baseline 동기 | 큐 안 씀. admin이 응답 대기(<60s). 그래서 mmr_job에 BASELINE 타입 없음 |
| baseline_version | loltrix 생성("YYYY-MM"). 같은 달 재계산 충돌 → 시각 suffix 또는 body로 명시 |
| baseline 데이터 수집 | 시즌 전체 길드 통합, 적격 row만(skip/fail 경기 제외) |
| 권한 | 게이트 없음. guildId는 body(POST), GET 필터만 `decodeGuildId` |
| RECALC | 수동 트리거 없음 — (재)구독 시에만 |
| 경기 제외 done | 역산 롤백 + soft delete(삭제와 동일 메커니즘, step14) |
| 큰 payload | baseline matches 배열이 수천~수만 row. gmok 60s 타임아웃, 메모리 주의 |

---

## 7. 완료 기준 (DoD)

- [ ] baseline: 시즌 적격 row 수집 → gmok 호출 → saveBaseline(activate) → 시즌 active 1개
- [ ] baseline 경기 부족 → 422 `INSUFFICIENT_DATA` 반환, 상태 변경 없음
- [ ] 경기 제외 wait: metric·queue `is_deleted=true`
- [ ] 경기 제외 done: 역산 롤백 + metric/queue/result/history `is_deleted=true` (replay 유지)
- [ ] job list/cancel/retry 동작(상태 제약 포함)
- [ ] GET jobs의 guildId 필터는 decodeGuildId, POST는 디코딩 없음

---

## 8. 의존성 / 다음 step

- **선행**: [step04](./step04_baseline.md)(saveBaseline) · [step05](./step05_job_queue.md)(enqueue·list·cancel·retry) · [step06](./step06_mmr_client.md)(calculateBaseline) · `mmrGuildState`(step07) · `systemConfig`
- **선행**: [step14](./step14_deletion_rollback.md)(경기 제외가 재사용하는 역산 롤백 서비스)
- **후행**: [step12](./step12_crons.md)(cleanup) · [step13](./step13_integration_test.md)
</content>
