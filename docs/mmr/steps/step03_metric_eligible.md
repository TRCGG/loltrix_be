# step03 — MMR 계산 대상 등록 (mmr_match_queue)

> 상위 문서: [00_overview §3.2](../00_overview.md) | [01_architecture §3.1](../01_architecture.md) | [02_data_model §2.6](../02_data_model.md)
> 선행: [step02_schema.md](./step02_schema.md) | 다음: [step04_baseline.md](./step04_baseline.md)

---

## 1. 목적 / 범위

업로드된 경기를 **구독 길드면 `mmr_match_queue`에 `wait`/`skip`으로 등록**한다(= MMR 계산 대상). 비구독 길드는 등록하지 않는다(metric만 쌓임).

> ✅ **metric 적재·`is_mmr_eligible` 판정·backfill은 상대전적이 dev에 이미 구현**했다 — `src/services/mmrMetric.service.ts`(`buildMetricRows`·`insertMetrics`·`judgeIsMmrEligible`·`isMatchEligibleForMmr`) + `replaySave.facade`의 모든-길드 metric hook + `scripts/backfill_mmr_participant_metric.sql`. **그대로 재사용**하고 새로 만들지 않는다.
>
> **이 step에서 실제로 새로 할 것은 단 두 가지**: ① 구독 게이트 `guildSubscription.isMmrActive` ② `mmr_match_queue` 등록(`insertInitialStatus`) + facade hook에 큐 등록 한 줄 추가.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/guildSubscription.service.ts` | 신규 — `isMmrActive` |
| `src/services/mmrMatchQueue.service.ts` | 신규 — `insertInitialStatus` (wait/skip) |
| `src/facade/replaySave.facade.ts` | **수정** — 기존 metric hook 뒤에 큐 등록 추가 |
| `src/services/mmrMetric.service.ts` | (변경 없음) dev 구현 재사용 |

---

## 2. facade hook 확장

dev의 `saveMatchData`는 이미 **모든 길드 metric 적재**까지 한다. 여기에 **구독 길드 큐 등록**만 덧붙인다.

```ts
// (기존, dev) 모든 길드 metric 적재
const metricRows = await mmrMetricService.buildMetricRows({ ...,  puuidToPlayerCodeMap });
await mmrMetricService.insertMetrics(metricRows, tx);

// ── (추가, 이 step) 구독 active 길드만 mmr_match_queue 등록 ──
if (await guildSubscriptionService.isMmrActive(savedReplay.guildId, tx)) {
  const eligible = mmrMetricService.isMatchEligibleForMmr(metricRows);   // dev에 이미 있음
  await mmrMatchQueueService.insertInitialStatus(
    { customMatchId: customMatchData.id, guildId: savedReplay.guildId, season: savedReplay.season,
      status: eligible ? 'wait' : 'skip' },
    tx,
  );
}
```

- `isMatchEligibleForMmr`(10명·5포지션×2·전원 per-row 적격)는 dev `mmrMetric.service`에 **이미 구현**돼 있다 → 호출만.
- 경기 내 1명이라도 부적격이면 `skip`, 정상이면 `wait`(1시간 뒤 worker 처리 대상).

### 2.1 `guildSubscription.isMmrActive`

```ts
async isMmrActive(guildId: string, tx?: TransactionType): Promise<boolean> {
  const x = tx ?? db;
  const rows = await x.select({ id: guildSubscription.id }).from(guildSubscription)
    .where(and(
      eq(guildSubscription.guildId, guildId),
      eq(guildSubscription.serviceKey, 'MMR'),
      eq(guildSubscription.status, 'active'),
    )).limit(1);
  return rows.length > 0;
}
```

### 2.2 `mmrMatchQueue.insertInitialStatus`

```ts
async insertInitialStatus(
  args: { customMatchId: string; guildId: string; season: string; status: 'wait' | 'skip' },
  tx: TransactionType,
) {
  const [row] = await tx.insert(mmrMatchQueue).values(args).returning();
  return row;
}
```

---

## 3. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| metric / 적격 판정 / backfill | **dev `mmrMetric.service` 재사용** (이 step에서 안 건드림) |
| `mmr_match_queue` 등록 | **구독 active 길드만** = MMR 계산 대상. 비구독은 metric만 |
| 트랜잭션 | 업로드 tx 안에서 큐 등록. 실패 시 업로드 전체 롤백 |
| 부적격 경기 | 구독 길드면 queue `skip`으로 등록(통계·metric엔 그대로 보존) |
| `played_date` | dev metric이 `customMatch.createDate`로 적재 (raw에 게임 시각 없음) |

> `is_mmr_eligible` 판정 기준(5분·15분 항복·AFK·5포지션 구조)은 [02 §2.6](../02_data_model.md) 참고. 구현은 dev `judgeIsMmrEligible`/`isMatchEligibleForMmr`.

---

## 4. 완료 기준 (DoD)

- [ ] 비구독 길드 업로드: metric만 적재, `mmr_match_queue` 미생성
- [ ] 구독 active 길드 정상 경기 업로드: `mmr_match_queue = wait`
- [ ] 구독 active 길드 부적격 경기(10명 아님·포지션 비정상·per-row 부적격): `mmr_match_queue = skip`
- [ ] 큐 등록이 업로드 tx 안에서 원자적 (실패 시 롤백)
- [ ] `mmrMetric.service`는 신규 작성 없이 dev 것 재사용

---

## 5. 의존성 / 다음 step

- **선행**: [step02](./step02_schema.md)(`mmr_match_queue`·`guild_subscription` 타입) · dev `mmrMetric.service`(metric·적격)
- **후행**: [step07](./step07_subscription.md)(`guildSubscription` 확장 subscribe/cancel) · [step08](./step08_incremental_worker.md)(wait 경기 처리)
