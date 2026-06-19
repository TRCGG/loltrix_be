# step12 — daily 알람 + monthly partition cron

> 상위 문서: [01_architecture §3.5](../01_architecture.md) | [02_data_model §2.8, §5](../02_data_model.md) | [00_overview §3.3](../00_overview.md)
> 선행: [step05](./step05_job_queue.md) · [step08](./step08_incremental_worker.md) | 다음: [step13_integration_test.md](./step13_integration_test.md)

---

## 1. 목적 / 범위

`node-cron`([step08 §2](./step08_incremental_worker.md))으로 도는 정기 작업.

| 스케줄 | cron | 작업 |
|---|---|---|
| **daily 10시 KST** | `0 10 * * *` (`Asia/Seoul`) | 24h+ `wait` 경기 알람(처리 적체 경보) |
| **monthly 1일 00시** | `0 0 1 * *` (`Asia/Seoul`) | 다음달 `mmr_history` 파티션 생성 |

> ⚠️ **hard delete(CLEANUP) 없음** — 구독 해지·경기 삭제는 **soft delete(`is_deleted=true`)로 영구 보존**한다. 조회는 전부 `is_deleted=false` 필터라 화면엔 안 보이고, 재구독 시 RECALC가 현재 시즌 summary를 덮어쓴다. 데이터 회수가 필요 없어 cleanup 잡·30일 유예·24개월 파티션 DROP을 **두지 않는다**([00 §3.5](../00_overview.md), [02 §5](../02_data_model.md)).
>
> (재)구독 RECALC가 `scheduled_date=10시 KST`로 예약돼 있어([step07](./step07_subscription.md)) 같은 10시 창에 worker가 픽업한다 → 10시 = 무거운 배치 창.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/workers/mmrScheduler.ts` | 확장 — daily(알람)·monthly(파티션) schedule (step08과 같은 파일) |
| `src/services/mmrPartition.service.ts` | 신규 — 다음달 파티션 생성 |
| config | `MMR_WAIT_ALARM_HOURS`(=24) |

---

## 2. daily cron (10시 KST) — 적체 알람

```
cron('0 10 * * *', Asia/Seoul):
  stuck = SELECT count(*), ... FROM mmr_match_queue
          WHERE status='wait' AND is_deleted=false
            AND create_date <= NOW() - INTERVAL '24 hours'   -- MMR_WAIT_ALARM_HOURS
  if (stuck > 0) alarm(...)        // 처리 적체 경보 (v1은 로깅/에러로그, 외부 알림은 후속)
```

> daily cron은 RECALC를 트리거하지 않는다(soft-delete only — cleanup 없음). 적체 알람·monthly 파티션 생성만. (재)구독 RECALC는 step07이 `scheduled_date=10시`로 예약한 것을 worker가 픽업.

---

## 3. monthly partition cron

`mmr_history`는 `create_date` monthly range partition([step01 §3.7](./step01_migration.md)). 다음달 분을 **미리** 만들어 둔다(INSERT가 파티션 없어 실패하는 일 방지).

```
cron('0 0 1 * *', Asia/Seoul):
  mmrPartition.ensureNextMonth():
     ym    = 다음달 (예: 2026-07)
     from  = '2026-07-01', to = '2026-08-01'
     CREATE TABLE IF NOT EXISTS mmr_history_202607 PARTITION OF mmr_history
       FOR VALUES FROM (from) TO (to);
     CREATE INDEX IF NOT EXISTS idx_mmr_history_202607_guild_season_puuid_create
       ON mmr_history_202607 (guild_id, season, puuid, create_date DESC);
```

- 생성은 `IF NOT EXISTS`로 멱등. **부팅 시 한 번 `ensureNextMonth` 호출**해 누락 방지(확정).
- **파티션 DROP 없음** — soft delete 영구 보존 정책이라 과거 파티션도 유지. (보존 압박이 생기면 추후 아카이브 정책 추가.)
- raw SQL은 `db.execute(sql\`...\`)`로 실행(Drizzle은 파티션 미관리, [step02 §4](./step02_schema.md)).

---

## 4. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 스케줄러 | node-cron, `Asia/Seoul`. 부팅 시 start([step08](./step08_incremental_worker.md)) |
| **CLEANUP 없음** | soft delete 영구 보존. hard delete 잡·30일 유예·24개월 DROP 전부 제거 |
| RECALC 트리거 | daily cron에 없음. (재)구독만(step07) |
| 파티션 미리 생성 | 매월 1일 다음달분 + 부팅 시 보강. 누락 시 그 달 INSERT 실패하므로 |
| 알람 채널 | v1은 로깅/에러로그. 외부 알림 연동은 후속 |
| 단일 인스턴스 | cron 중복 발사는 `IF NOT EXISTS`(파티션)·조회 알람이라 무해 |

---

## 5. 완료 기준 (DoD)

- [ ] daily 10시 KST: 24h+ wait 경기 있으면 알람(로깅)
- [ ] monthly: 다음달 파티션 + 인덱스 생성(멱등)
- [ ] 파티션 누락 상태에서 부팅 보강으로 INSERT 실패 방지
- [ ] 모든 cron `Asia/Seoul` 기준
- [ ] hard delete(CLEANUP) 잡 없음 — soft delete row는 영구 보존

---

## 6. 의존성 / 다음 step

- **선행**: [step08](./step08_incremental_worker.md)(스케줄러) · [step01](./step01_migration.md)(파티션 구조)
- **후행**: [step13](./step13_integration_test.md)(통합 테스트)
