# step07 — 구독 시작 / 해지 / 재구독 API

> 상위 문서: [00_overview §3.1, §3.5](../00_overview.md) | [01_architecture §3.3](../01_architecture.md)
> 선행: [step04_baseline.md](./step04_baseline.md) · [step05_job_queue.md](./step05_job_queue.md) | 다음: [step08_incremental_worker.md](./step08_incremental_worker.md)

---

## 1. 목적 / 범위

길드의 MMR **구독 시작 / 해지 / 재구독** 을 처리하는 관리자 API. 구독 상태(`guild_subscription`) 전이 + 계산 상태(`mmr_guild_state`) 초기화 + RECALC job enqueue + soft-delete 복원을 엮는다.

- 구독은 **관리자 수동**([00 §3.1](../00_overview.md)) → `requireAdmin` 게이트.
- 실제 backfill·계산은 enqueue한 RECALC job을 worker(step08)가 처리. 이 API는 **상태 세팅 + enqueue까지**, 응답은 즉시 반환.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/routes/mmrSubscription.routes.ts` | 신규 — subscribe / cancel |
| `src/controllers/mmrSubscription.controller.ts` | 신규 |
| `src/services/guildSubscription.service.ts` | 확장 — `subscribe` / `cancel` (step03의 `isMmrActive`에 추가) |
| `src/services/mmrGuildState.service.ts` | 신규 — 상태 행 upsert·전이 |
| `src/routes/index.ts` | mmrSubscription 라우트 등록 |

---

## 2. 엔드포인트

| 메서드 | 경로 | 권한 | 요청 |
|---|---|---|---|
| POST | `/api/mmr/subscribe` | 없음 | body `{ guildId }` (season은 서버가 `LOL_SEASON`에서 결정) |
| DELETE | `/api/mmr/subscribe` | 없음 | body `{ guildId }` |

- **권한 게이트 없음** — `requireAdmin` 등 role 미들웨어를 붙이지 않는다.
- **`guildId`는 body로 받는다** → base64 디코딩 불필요. (`decodeGuildId`는 **GET 라우트 전용** 컨벤션이라 여기엔 안 씀.)
- `validateRequest`로 body 검증.
- 라우트 정의: `router.post('/subscribe', validateRequest(schema), handler)`.

응답(즉시):
```json
{ "guildId": "...", "season": "2026", "status": "wait_init", "message": "MMR 초기 계산을 시작했습니다." }
```

---

## 3. 구독 시작 / 재구독 흐름

재구독도 전체 RECALC로 통일(§5a) → **분기 없는 단일 경로**.

```
subscribe(guildId)   ── 단일 TX ──
  season = systemConfig.LOL_SEASON                       (업로드와 동일 소스, §5b)
  guild_subscription upsert: status=active, enabled_date=now, ended_date=null
  mmr_guild_state(guildId, season) upsert: status=wait_init
  enqueue RECALC job (guildId, season, scheduledDate=다음 오전 10시 KST)
                                         (같은 길드 RECALC가 wait/run이면 생략)
  → 응답 { season, status: 'wait_init' }
```

**RECALC는 즉시가 아니라 다음 오전 10시 KST에 예약**한다(§5c). 1년치 데이터면 20분+ 걸리는 무거운 작업이라, 내전·incremental이 없는 한산한 시간대(=daily cron 창)에 몰아 처리한다. worker가 `scheduled_date`를 보고 10시 후 tick에 픽업하므로, 그때까지 길드는 `wait_init`(계산 중)으로 보인다.

worker가 RECALC를 픽업: summary 초기화(전원 1300, **is_deleted=false**) → eligible 경기 played_date ASC 전량 incremental 반복 → `mmr_guild_state=ready` ([01 §3.3](../01_architecture.md), 핸들러는 step08). metric은 전 길드 적재라 raw 재파싱 backfill 불필요.

> 해지 때 정리된(soft-deleted 후 hard delete된) 데이터를 RECALC가 metric에서 summary/result/history로 **재구축**하므로 **별도 복구 단계가 없다.** 해지 후 경과 기간과 무관하게 동일.

---

## 4. 해지 흐름

```
cancel(guildId)   ── 단일 TX ──
  guild_subscription: status=cancelled, ended_date=now
  mmr_member_summary(guildId, *) is_deleted=true        ← 리더보드 즉시 숨김 (soft delete)
  → 응답
```

- 해지 즉시 summary `is_deleted=true`로 **리더보드 숨김**. 데이터 hard delete는 **다음 daily CLEANUP**([step12](./step12_crons.md))이 **유예 없이**(`status='cancelled'` 기준) 수행. metric은 보존(재구독 RECALC 복원).
- 해지 후 업로드: facade hook이 `isMmrActive=false`라 metric·queue 미생성([step03](./step03_metric_eligible.md)) → 자연히 MMR 누적 멈춤.
- `mmr_match_queue`의 잔여 `wait`/run 잡 처리: 해지 시 해당 길드 wait 경기를 `skip`으로 정리할지(권장) — §5 참조.

---

## 5. 결정 완료

### (a) 재구독 = 전체 RECALC
해지 후 경과 기간과 무관하게 재구독은 신규와 **동일하게 전체 RECALC**. 해지 기간에 쌓인 갭 경기도 함께 처리되고(metric은 전 길드 적재), 해지 때 정리된 데이터는 metric에서 summary/result/history로 재구축된다. "계산 없이 즉시 복구"는 포기 — **단순·정확** 우선.

### (b) 현재 시즌 = `system_config.LOL_SEASON`
업로드가 쓰는 `systemConfigService.getConfigOrDefault('LOL_SEASON', ...)`([replay.service.ts:219](src/services/replay.service.ts#L219))를 **그대로 재사용**. 관리자가 수동으로 변경(≈연 1회). 구독·RECALC·업로드가 같은 소스라 시즌이 어긋날 일 없음. 새 config 추가 안 함.

### (c) RECALC 실행은 다음 오전 10시 KST 예약
RECALC는 1년치면 20분+ 걸리는 무거운 작업(경기 순서 의존이라 병렬 불가). 즉시 돌리면 그동안 worker가 다른 길드 incremental을 못 처리한다. → **구독 시 enqueue하되 `scheduled_date`를 다음 오전 10시 KST로** 잡아, 내전·incremental이 한산한 시간대(daily cron 창)에 몰아 처리. worker의 `scheduled_date <= NOW()` 조건이 자연히 10시까지 대기시킨다. 그때까지 길드는 `wait_init`. config `MMR_RECALC_HOUR_KST`=10.

---

## 6. 서비스 스케치

```ts
// guildSubscription.service.ts (step03 isMmrActive에 추가)
async subscribe(guildId: string): Promise<{ season: string; status: 'wait_init' }> {
  return db.transaction(async (tx) => {
    const season = await systemConfigService.getConfigOrDefault('LOL_SEASON', 'error_season');
    await this.upsertActive(guildId, tx);                          // status=active, enabled_date=now, ended_date=null
    await mmrGuildStateService.upsert(guildId, season, 'wait_init', tx);
    // 같은 길드 RECALC가 wait/run이면 enqueue 생략(중복 방지)
    if (!(await mmrJobService.hasPendingRecalc(guildId, season, tx))) {
      // RECALC는 다음 오전 10시 KST에 예약 (무거운 작업을 한산한 창으로)
      await mmrJobService.enqueueJob({ jobType: 'RECALC', guildId, season, scheduledDate: nextRecalcWindow() }, tx);
    }
    return { season, status: 'wait_init' };
  });
}

async cancel(guildId: string): Promise<void> {
  return db.transaction(async (tx) => {
    await this.setCancelled(guildId, tx);                          // status=cancelled, ended_date=now
    await mmrMemberSummaryService.softDelete(guildId, tx);         // is_deleted=true (그 길드 전 시즌)
  });
}
```

> `hasPendingRecalc`는 step05 `mmrJobService`에 추가하는 헬퍼(같은 guild+season에 wait/run RECALC 존재 여부). 재구독 연타 시에도 중복 잡을 막는다.

```ts
// mmrGuildState.service.ts
async upsert(guildId, season, status, tx) { /* INSERT ... ON CONFLICT(guild_id,season) DO UPDATE status */ }
async setStatus(guildId, season, status, tx) { /* UPDATE status */ }
async get(guildId, season, tx?) { /* 단건 (조회 게이트·worker용) */ }
```

---

## 7. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 권한 | **게이트 없음** (role 미들웨어 미적용). `guildId`는 body로 받아 디코딩 불필요 |
| 멱등 | 이미 active인 길드 재-subscribe: no-op 또는 RECALC 재enqueue(중복 방지 — 같은 길드 wait/run RECALC 있으면 skip) |
| 응답 즉시성 | enqueue까지만. 계산은 worker. 응답은 `wait_init`/`ready` 상태 반환 |
| soft delete 범위 | 해지 시 `mmr_member_summary`(그 길드 전 시즌) `is_deleted=true`. `mmr_match_result`/`mmr_history`는 그대로(=cleanup 때 hard delete, step12) |
| 트랜잭션 | subscribe/cancel 각각 단일 TX. enqueue도 같은 TX |
| 비범위 | RECALC 핸들러 로직=step08, baseline=step04/11, cleanup=step12 |

---

## 8. 완료 기준 (DoD)

- [ ] 구독(신규·재구독 동일): `guild_subscription=active`, `mmr_guild_state=wait_init`, RECALC enqueue
- [ ] season은 `system_config.LOL_SEASON`에서 결정(업로드와 동일 값)
- [ ] 재구독 시 soft-deleted summary가 RECALC 후 `is_deleted=false`로 복원됨
- [ ] 해지: `status=cancelled`, `ended_date` 기록, summary `is_deleted=true`
- [ ] 해지 후 업로드: metric·queue 미생성(누적 멈춤)
- [ ] 같은 길드 RECALC 중복 enqueue 방지(`hasPendingRecalc`)

---

## 9. 의존성 / 다음 step

- **선행**: [step03](./step03_metric_eligible.md)(`isMmrActive`·metric) · [step05](./step05_job_queue.md)(enqueue·`hasPendingRecalc`) · `systemConfigService`(`LOL_SEASON`) · 미들웨어(`validateRequest`)
- **후행**: [step08](./step08_incremental_worker.md)(RECALC·backfill 핸들러) · [step12](./step12_crons.md)(cleanup)
</content>
