# step08 — 30분 incremental cron worker

> 상위 문서: [01_architecture §3.2, §3.3](../01_architecture.md) | [00_overview §3.2](../00_overview.md)
> 선행: [step04](./step04_baseline.md) · [step05](./step05_job_queue.md) · [step06](./step06_mmr_client.md) | 다음: [step09_result_save.md](./step09_result_save.md)

---

## 1. 목적 / 범위

평소 운영의 메인 경로. **30분 주기 cron**이 처리 대상 길드를 큐에 올리고, worker가 `INCREMENTAL_BATCH`/`RECALC` 잡을 처리한다. 이 step은 **오케스트레이션** — 스케줄러, 핸들러 2종, 경기당 payload 조립 + gmok 호출까지. **결과 저장 트랜잭션은 [step09](./step09_result_save.md)** 가 맡는다.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/mmrIncremental.service.ts` | 신규 — `processMatch` / `runIncrementalBatch` / `runRecalc` |
| `src/workers/mmrScheduler.ts` | 신규 — 30분 cron + 핸들러 등록 + tick 구동 |
| `src/index.ts` | 부팅 후 스케줄러 start |
| config | `MMR_PROCESS_DELAY_MINUTES`(=60), `MMR_WORKER_INTERVAL_MIN`(=30), `MMR_WORKER_MAX_JOBS`(=5), `MMR_RECALC_HOUR_KST`(=10) |

---

## 2. 스케줄러 — node-cron (확정)

레포에 스케줄러가 없어 **`node-cron`을 추가**한다. cron 표현식으로 30분(`*/30 * * * *`) + step12 daily(`0 10 * * *`, KST) + monthly 파티션을 한 의존성으로 처리. 부팅 후 `src/index.ts`에서 schedule을 start한다.

- **단일 인스턴스 가정.** 다중 인스턴스로 확장 시 cron 중복 발사 가능 → enqueue는 `hasPending` dedup, tick은 `SKIP LOCKED`가 방어(별도 분산 락 불필요).
- 타임존: daily는 `{ timezone: 'Asia/Seoul' }`로 10시 KST 고정.

---

## 3. 30분 cron 흐름

```
every 30min (MMR_WORKER_INTERVAL_MIN):
  1) ENQUEUE  — 처리 대상 길드를 INCREMENTAL_BATCH로 올림 (중복 방지)
       guilds = SELECT DISTINCT guild_id, season FROM mmr_match_queue
                WHERE status='wait' AND is_deleted=false
                  AND create_date <= NOW() - INTERVAL '60 min'   -- MMR_PROCESS_DELAY_MINUTES
       for (g, season) in guilds:
         if !hasPending(g, season, ['INCREMENTAL_BATCH','RECALC']):  enqueueJob(INCREMENTAL_BATCH, g, season)
  2) DRAIN    — 큐 처리
       mmrWorker.tick({ maxJobs: MMR_WORKER_MAX_JOBS })
```

- ENQUEUE는 "1시간 경과한 wait 경기 보유 길드"만. 이미 RECALC/배치가 걸린 길드는 skip(중복 방지).
- DRAIN은 step05 worker. 동시성은 `SKIP LOCKED` + per-guild `NOT EXISTS`가 보장.

---

## 4. 핸들러 (부팅 시 mmrWorker에 등록)

```ts
mmrWorker.registerHandler('INCREMENTAL_BATCH', (job) => mmrIncremental.runIncrementalBatch(job.guildId!, job.season!));
mmrWorker.registerHandler('RECALC',            (job) => mmrIncremental.runRecalc(job.guildId!, job.season!));
// CLEANUP 핸들러는 step12
```

### 4.1 `runIncrementalBatch(guildId, season)`

```
baseline = getActiveBaseline(season)
if (!baseline) return                      // no-op 성공 → 경기 wait 유지, 다음 tick 재시도 (fail 아님)

matches = SELECT custom_match_id FROM mmr_match_queue
          WHERE guild_id=? AND season=? AND status='wait' AND is_deleted=false
            AND create_date <= NOW()-60min
          ORDER BY (해당 경기 played_date) ASC
for each customMatchId:
  await processMatch(customMatchId, guildId, season, baseline)
```

> **baseline 없으면 fail이 아니라 no-op**([01 §2-D](../01_architecture.md)). 잡은 done 되지만 경기는 wait로 남아 다음 tick에 재시도된다.

### 4.2 `runRecalc(guildId, season)` — 멱등 재시작

```
baseline = getActiveBaseline(season); if (!baseline) return   // baseline 생길 때까지 대기

[Step 1] summary 초기화: guild+season 전원 total/pos=1300, games=wins=0, is_deleted=false
[Step 2] eligible 경기(is_mmr_eligible=true AND is_deleted=false)를 played_date ASC 전체 순회
         → 각 경기 mmr_match_queue 없으면 wait 등록 + processMatch
[Step 3] mmr_guild_state = ready
```

> **RECALC는 예약 실행**: 구독/재구독 시 `scheduled_date=다음 오전 10시 KST`로 enqueue됨([step07](./step07_subscription.md)). worker `pickNextJob`이 `scheduled_date <= NOW()`라 10시 후 tick에 픽업한다. 1년치면 20분+(경기 순서 의존 → 병렬 불가)라 한산한 창에 몰기 위함.
> **metric backfill 없음**: metric은 **업로드 시 모든 길드에 적재**(step03)되므로 RECALC가 raw 재파싱할 필요가 없다. 기존 경기는 일회성 backfill SQL로 이미 채워진 상태 전제([step03 §7](./step03_metric_eligible.md)).
> **멱등**([기획 §6.3](../00_overview.md)): RECALC 재시도 시 **항상 Step 1(초기화)부터 전량 재실행**. 중간부터 안 이어간다.

---

## 5. `processMatch` — 경기 1건 (payload 조립 + gmok 호출)

```ts
async processMatch(customMatchId, guildId, season, baseline) {
  // 1) 입력 로드 + metric→interface 변환 (is_deleted=false 인 metric만)
  const rows = await metric.getMatchRows(customMatchId);             // 10 PlayerGameRow, WHERE is_deleted=false
  const puuids = rows.map(r => r.puuid);
  const preMatchUserSummary = await summary.getPreMatch(guildId, season, puuids);  // 포지션별 state

  // 2) calculation_id (nanoid, 03 §10)
  const calculationId = `MMR-${yyyymmddUTC()}-${nanoid()}`;

  // 3) 요청 조립 — baseline은 매 호출 동일하게 실음 (03 §7.3)
  const req: MatchCalcRequest = {
    guild_id: guildId, season, calculation_id: calculationId, custom_match_id: customMatchId,
    baseline_version: baseline.baselineVersion,
    mmr_baseline: baseline.mmrBaseline, game_impact_baseline: baseline.gameImpactBaseline,
    match_rows: rows, pre_match_user_summary: preMatchUserSummary,
  };

  // 4) gmok 호출 (DB tx 밖)
  let res: MatchCalcResponse;
  try {
    res = await mmrClient.calculateMatch(req);                       // step06
  } catch (e) {
    if (e instanceof MmrContractError) {                            // 400/422 — 결정적 실패
      await matchQueue.markFail(customMatchId, e.errorCode + ': ' + e.message);  // queue=fail, 재시도 안 함
      return;                                                       // 이 경기만 건너뜀(잡은 계속)
    }
    throw e;                                                        // MmrServiceError → 상위로 → job markFail → 재시도
  }

  // 5) 결과 저장 (단일 TX, 멱등 + 재처리 가드) → step09
  await mmrResultSave.save(res);
}
```

**`getMatchRows` — metric→interface 변환**([03 §3](../03_api_contract.md)): `mmr_participant_metric`은 변환값(blue/red·enum·1/0)을 이미 저장하므로 변환은 **(a) 필드명 리네임** + **(b) `match_participant_id` 부착** 둘뿐이다.
- (a) 리네임: `kills→kill`, `gold_earned→gold`, `game_duration→time_played`, `damage_to_champions→total_damage_champions`, `damage_to_turrets→total_damage_dealt_to_buildings`, `control_wards_bought→vision_bought` 등. metric의 raw 49개 중 **interface가 요구하는 필드만** 골라 보냄(나머지는 저장 전용).
- (b) `match_participant_id`: metric엔 없음(자연키 `(custom_match_id, puuid)`). `mmr_match_result`/`mmr_history` 멱등 키라 payload엔 필수 → `match_participant`를 `custom_match_id` + `puuid→player_code`(riot_account)로 join해 부착.

**`pre_match_user_summary` 조립**: `mmr_member_summary`에서 10명 행을 읽어 `{ puuid, positions: [{position, pos_mmr, pos_games, pos_wins}] }` 형태로. 없는 유저/포지션은 보내지 않으면 gmok이 신규(1300)로 간주([03 §5.1](../03_api_contract.md)).

---

## 6. 에러 분기 요약 ([step06 §3](./step06_mmr_client.md) / [03 §9](../03_api_contract.md))

| 발생 | 처리 | 잡 영향 |
|---|---|---|
| `MmrContractError` (400/422) | 해당 경기 `mmr_match_queue=fail`, **건너뜀** | 잡 계속(다른 경기 처리) → 결국 done |
| `MmrServiceError` (5xx/timeout/다운) | rethrow | worker `markFail` → attempts<3면 재시도, 초과 fail |
| gmok 전체 다운 | 첫 경기에서 throw → 잡 전체 재시도. (선택: tick 시작 시 `health()` ping으로 조기 skip) | 다음 tick 자동 재시도 |

> 배치 중간 `MmrServiceError`로 잡이 재시도되면: **INCREMENTAL_BATCH**는 done 경기를 건너뛰어 실패 지점부터 재개. **RECALC**는 §4.2대로 처음부터 전량 재실행.

---

## 7. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 스케줄러 | **node-cron**. 30분 + step12 daily/monthly 공유. 단일 인스턴스 가정 |
| 처리 딜레이 | `create_date <= NOW() - 60min`. config `MMR_PROCESS_DELAY_MINUTES` |
| baseline 없음 | fail 아님 → no-op, 경기 wait 유지, 다음 tick 재시도 |
| 순서 | `played_date ASC` 엄수(incremental 결과 좌우). RECALC도 동일 |
| gmok 호출 위치 | DB tx **밖**. 저장만 tx(step09) |
| baseline 고정 | 매 호출 같은 baseline 실음(03 §7.3). RECALC마다 재학습 ❌ |
| RECALC 멱등 | 재시도 시 초기화부터 전량 |
| 중복 enqueue | `hasPending(guild, season)` 가드 (step05/07) |

---

## 8. 완료 기준 (DoD)

- [ ] 30분 cron이 1시간 경과 wait 경기 보유 길드를 INCREMENTAL_BATCH로 enqueue(중복 없이) 후 tick
- [ ] INCREMENTAL_BATCH: wait+1h 경기를 played_date ASC로 1건씩 processMatch
- [ ] baseline 없으면 no-op(경기 wait 유지, fail 아님)
- [ ] RECALC: summary 초기화 → eligible 전량 replay → ready (metric backfill 없음)
- [ ] RECALC 재시도 시 초기화부터 전량 재실행(멱등)
- [ ] `MmrContractError` → 그 경기 queue=fail, 잡은 계속
- [ ] `MmrServiceError` → 잡 재시도(다음 tick)
- [ ] pre_match_user_summary 누락 유저/포지션 → gmok 신규(1300) 처리 확인

---

## 9. 의존성 / 다음 step

- **선행**: [step04](./step04_baseline.md)(getActiveBaseline) · [step05](./step05_job_queue.md)(worker/enqueue) · [step06](./step06_mmr_client.md)(calculateMatch) · [step03](./step03_metric_eligible.md)(buildMetricRows 재사용)
- **후행**: [step09](./step09_result_save.md)(`mmrResultSave.save` — 단일 TX 멱등 저장) · [step12](./step12_crons.md)(daily RECALC enqueue·CLEANUP, 같은 스케줄러)
</content>
