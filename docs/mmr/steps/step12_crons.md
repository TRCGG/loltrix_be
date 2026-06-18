# step12 — daily cron + monthly partition cron

> 상위 문서: [01_architecture §3.5](../01_architecture.md) | [02_data_model §2.8, §5](../02_data_model.md) | [00_overview §3.3](../00_overview.md)
> 선행: [step05](./step05_job_queue.md) · [step08](./step08_incremental_worker.md) | 다음: [step13_integration_test.md](./step13_integration_test.md)

---

## 1. 목적 / 범위

`node-cron`([step08 §2](./step08_incremental_worker.md))으로 도는 정기 작업.

| 스케줄 | cron | 작업 |
|---|---|---|
| **daily 10시 KST** | `0 10 * * *` (`Asia/Seoul`) | ① CLEANUP enqueue(hard delete — 구독 해지분[유예 없음] + 삭제된 경기[30일 경과]) ② 24h+ wait 알람 |
| **monthly 1일 00시** | `0 0 1 * *` (`Asia/Seoul`) | 다음달 `mmr_history` 파티션 생성 + 2년 경과 파티션 정리 |

> 한산한 시간대(오전 10시)에 무거운 작업을 몰기 위함([00 §3.3](../00_overview.md)). CLEANUP은 `mmr_job` 큐를 거쳐 worker가 실행.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/workers/mmrScheduler.ts` | 확장 — daily·monthly schedule 추가 (step08과 같은 파일) |
| `src/services/mmrCleanup.service.ts` | 신규 — CLEANUP 핸들러(hard delete) |
| `src/services/mmrPartition.service.ts` | 신규 — 파티션 생성/정리 |
| config | `MMR_SOFT_DELETE_GRACE_DAYS`(=30, **삭제 경기 전용**; 구독 해지는 유예 없음), `MMR_HISTORY_RETENTION_MONTHS`(=24), `MMR_WAIT_ALARM_HOURS`(=24) |

CLEANUP 핸들러 등록:
```ts
mmrWorker.registerHandler('CLEANUP', () => mmrCleanup.run());
```

---

## 2. daily cron (10시 KST)

```
cron('0 10 * * *', Asia/Seoul):
  // ① CLEANUP enqueue (해지분 즉시 + 삭제경기 30일 hard delete)
  if (!hasPending(CLEANUP)) enqueueJob(CLEANUP)        // guild 무관 단일 잡

  // ② 24h+ wait 알람
  stuck = SELECT count(*), ... FROM mmr_match_queue
          WHERE status='wait' AND is_deleted=false
            AND create_date <= NOW() - INTERVAL '24 hours'
  if (stuck > 0) alarm(...)                            // 처리 적체 경보
```

> **daily cron 자체는 RECALC를 트리거하지 않는다**(삭제는 역산 롤백, RECALC는 (재)구독만). 다만 (재)구독 RECALC가 `scheduled_date=10시 KST`로 예약돼 있어([step07](./step07_subscription.md)) **같은 10시 창에 worker가 그 RECALC들도 픽업**한다 → 10시 = RECALC + cleanup이 함께 도는 "무거운 배치 창".
- **wait 알람 채널**: 우선 로그/에러로그 테이블. (디스코드·슬랙 연동은 운영 결정, v1은 로깅.)

---

## 3. CLEANUP 핸들러 (hard delete) ([02 §5](../02_data_model.md))

두 종류의 soft-delete를 영구 삭제한다 — (A)구독 해지는 **유예 없이**(다음 CLEANUP), (B)삭제 경기는 **30일 경과 후**.

```
mmrCleanup.run():
  // (A) 구독 해지 길드 — 그 길드 MMR 데이터 전체 (유예 없음)
  expired = SELECT guild_id FROM guild_subscription
            WHERE status='cancelled'        -- 유예 없음. 재구독(active 전환)이면 자연 제외
  for guildId in expired:  ── 길드별 TX ──
    DELETE FROM mmr_match_queue    WHERE guild_id = ?
    DELETE FROM mmr_history        WHERE guild_id = ?
    DELETE FROM mmr_match_result   WHERE guild_id = ?
    DELETE FROM mmr_member_summary WHERE guild_id = ?

  // (B) 삭제된 경기(리플 삭제/경기 제외) 30일 경과 — is_deleted=true row만
  DELETE FROM mmr_match_queue       WHERE is_deleted=true AND update_date <= NOW() - INTERVAL '30 days'
  DELETE FROM mmr_match_result      WHERE is_deleted=true AND calculated_date <= NOW() - INTERVAL '30 days'
  DELETE FROM mmr_history           WHERE is_deleted=true AND create_date <= NOW() - INTERVAL '30 days'
  DELETE FROM mmr_participant_metric WHERE is_deleted=true AND update_date <= NOW() - INTERVAL '30 days'
```

> (B)는 summary는 건드리지 않는다 — 삭제 시 이미 역산 롤백됨([step14](./step14_deletion_rollback.md)). metric도 `is_deleted=true`인 것만 지운다(나머지 metric은 전 길드 보존).

**삭제 대상 / 보존** ([02 §5](../02_data_model.md)):

| hard delete | 보존(안 지움) |
|---|---|
| `mmr_member_summary` (is_deleted=true였던 것) | `mmr_participant_metric` (재구독 재활용) |
| `mmr_match_result` | `guild_subscription` (이력) |
| `mmr_history` | `mmr_season_baseline` (시즌 공유) |
| `mmr_match_queue` | `mmr_guild_state` (구독 상태 이력) |

> 재구독은 어차피 RECALC로 전량 재계산([step07](./step07_subscription.md))이라, metric만 남아 있으면 복구 가능. summary/result/history는 지워도 됨.

---

## 4. monthly partition cron

`mmr_history`는 `create_date` monthly range partition([step01 §3.8](./step01_migration.md)). 다음달 분을 **미리** 만들어 둔다(INSERT가 파티션 없어 실패하는 일 방지).

```
cron('0 0 1 * *', Asia/Seoul):
  mmrPartition.ensureNextMonth():
     ym    = 다음달 (예: 2026-07)
     from  = '2026-07-01', to = '2026-08-01'
     CREATE TABLE IF NOT EXISTS mmr_history_202607 PARTITION OF mmr_history
       FOR VALUES FROM (from) TO (to);
     CREATE INDEX IF NOT EXISTS idx_mmr_history_202607_guild_season_puuid_create
       ON mmr_history_202607 (guild_id, season, puuid, create_date DESC);

  mmrPartition.dropExpired():      // 2년 경과 파티션 정리 (기획 §6.14)
     보존 경계 = 오늘 - MMR_HISTORY_RETENTION_MONTHS(24)
     그 이전 파티션 → DETACH 후 DROP
```

- 생성은 `IF NOT EXISTS`로 멱등. **부팅 시 한 번 `ensureNextMonth` 호출**해 누락 방지(확정).
- 정리는 24개월 이전 파티션 **그냥 DROP**(v1 확정 — 별도 아카이브/백업 없음).
- raw SQL은 `db.execute(sql\`...\`)`로 실행(Drizzle은 파티션 미관리, [step02 §4](./step02_schema.md)).

---

## 5. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 스케줄러 | node-cron, `Asia/Seoul` 타임존. 부팅 시 start([step08](./step08_incremental_worker.md)) |
| **RECALC 트리거** | daily cron에 **없음**. 삭제·제외는 즉시 역산 롤백, RECALC는 (재)구독만 |
| CLEANUP 방식 | 큐(`mmr_job` CLEANUP) 경유 — worker가 실행, 다른 잡과 동일 관측·재시도 |
| CLEANUP 2종 | (A)해지 길드 전체(**유예 없음**) + (B)삭제된 경기(`is_deleted=true`) **30일 경과** row |
| 삭제 범위 | 해지: summary/result/history/queue. 경기삭제: 해당 경기의 metric/queue/result/history(`is_deleted` row만) |
| 파티션 미리 생성 | 매월 1일 다음달분. 누락 시 그 달 INSERT 실패하므로 부팅 시 보강 권장 |
| 보존 | history 24개월, 이후 파티션 DROP |
| 알람 채널 | v1은 로깅/에러로그. 외부 알림 연동은 후속 |
| 단일 인스턴스 | cron 중복 발사는 `hasPending` dedup + `SKIP LOCKED`로 방어 |

---

## 6. 완료 기준 (DoD)

- [ ] daily 10시 KST: CLEANUP 잡 enqueue(중복 없이) — RECALC 트리거 없음
- [ ] daily: 24h+ wait 경기 있으면 알람(로깅)
- [ ] CLEANUP(A): 해지 길드(`status='cancelled'`, 유예 없음)의 summary/result/history/queue hard delete
- [ ] CLEANUP(B): `is_deleted=true` 30일 경과 경기 row(metric/queue/result/history) hard delete
- [ ] monthly: 다음달 파티션 + 인덱스 생성(멱등), 24개월 경과분 DROP
- [ ] 파티션 누락 상태에서 부팅 보강으로 INSERT 실패 방지
- [ ] 모든 cron `Asia/Seoul` 기준

---

## 7. 의존성 / 다음 step

- **선행**: [step05](./step05_job_queue.md)(enqueue·CLEANUP 핸들러 등록) · [step08](./step08_incremental_worker.md)(스케줄러·RECALC 핸들러) · [step01](./step01_migration.md)(파티션 구조)
- **후행**: [step13](./step13_integration_test.md)(통합 테스트)
</content>
