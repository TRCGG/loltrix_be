# step05 — mmr_job 큐 + worker 골격

> 상위 문서: [01_architecture §2-E, §3.2](../01_architecture.md) | [02_data_model §2.4](../02_data_model.md)
> 선행: [step02_schema.md](./step02_schema.md) | 다음: [step06_mmr_client.md](./step06_mmr_client.md)

---

## 1. 목적 / 범위

모든 비동기 MMR 작업을 직렬화하는 **단일 큐(`mmr_job`)와 worker 골격**을 만든다. 이게 [01 §2-E](../01_architecture.md)에서 확정한 **동시성 단일화**의 구현체다.

- **job_type 3종**: `INCREMENTAL_BATCH` / `RECALC` / `CLEANUP`. (BASELINE은 큐에 안 넣음 — 동기 admin API, [step11](./step11_admin_api.md))
- worker는 **골격만** — 픽업·디스패치·성공/실패 처리 루프. 실제 처리 로직(핸들러)은 후속 step이 등록한다.
- cron/interval **트리거**는 별도 layer: incremental은 [step08](./step08_incremental_worker.md)(30분), cleanup·daily RECALC는 [step12](./step12_crons.md).

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/mmrJob.service.ts` | 신규 — enqueue / pickNextJob / markDone / markFail / cancel / retry / list / get |
| `src/workers/mmrWorker.ts` | 신규 — 핸들러 레지스트리 + `tick()` |
| config (env 또는 상수) | `MMR_JOB_MAX_ATTEMPTS = 3` |

---

## 2. 동시성 모델 (확정)

```
worker.tick()  (트리거: step08 cron 등)
  반복 (최대 N개):
    job = mmrJobService.pickNextJob(tx)   ← 짧은 자체 TX (SKIP LOCKED)
    if (!job) break
    handler = handlers[job.jobType]
    try { await handler(job) }            ← 핸들러는 픽업 TX 밖에서 실행 (gmok HTTP 동안 DB락 안 잡음)
       → markDone(job.id)
    catch (e) → markFail(job.id, msg)     ← attempts < MAX면 wait 환원, 아니면 fail
```

**핵심 두 장치** ([01 §2-E](../01_architecture.md)):
1. **`FOR UPDATE SKIP LOCKED`** — 여러 picker가 같은 잡을 두고 충돌하지 않음.
2. **per-guild `NOT EXISTS(run job)`** — 한 길드의 `INCREMENTAL_BATCH`/`RECALC`는 동시에 둘 이상 안 돎(누적 순서 보장). 다른 길드·`CLEANUP`(guild 없음)은 병렬 가능.

---

## 3. mmrJob.service.ts

### 3.1 enqueue

```ts
export type MmrJobType = 'INCREMENTAL_BATCH' | 'RECALC' | 'CLEANUP';
export type MmrJobStatus = 'wait' | 'run' | 'done' | 'fail' | 'cancel';

export interface EnqueueJobInput {
  jobType: MmrJobType;
  guildId?: string | null;   // INCREMENTAL_BATCH/RECALC 필수, CLEANUP은 null
  season?: string | null;
  scheduledDate?: Date;      // 기본 now. 재시도 시 재배치 등에 사용
}

async enqueueJob(input: EnqueueJobInput, tx?: TransactionType): Promise<MmrJob> {
  const x = tx ?? db;
  const [row] = await x.insert(mmrJob).values({
    jobType: input.jobType, status: 'wait',
    guildId: input.guildId ?? null, season: input.season ?? null,
    scheduledDate: input.scheduledDate ?? new Date(),
  }).returning();
  return row;
}
```

### 3.2 pickNextJob — 픽업 (반드시 TX 안에서)

```ts
async pickNextJob(tx: TransactionType): Promise<MmrJob | null> {
  const rows = await tx.update(mmrJob)
    .set({ status: 'run', startedDate: new Date(), attempts: sql`${mmrJob.attempts} + 1`, updateDate: new Date() })
    .where(sql`${mmrJob.id} = (
      SELECT m.id FROM mmr_job m
      WHERE m.status = 'wait' AND m.scheduled_date <= NOW()
        AND ( m.guild_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM mmr_job r
                WHERE r.guild_id = m.guild_id AND r.status = 'run'
                  AND r.job_type IN ('INCREMENTAL_BATCH','RECALC') ) )
      ORDER BY m.scheduled_date ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )`)
    .returning();
  return rows[0] ?? null;
}
```

- 픽업과 동시에 `status=run`, `started_date=now`, `attempts += 1`.
- `attempts`는 **픽업마다 증가** → 1번째 실행 시 `attempts=1`.

### 3.3 markDone / markFail

```ts
const MAX_ATTEMPTS = Number(process.env.MMR_JOB_MAX_ATTEMPTS ?? 3);

async markDone(jobId: number, tx?: TransactionType): Promise<MmrJob> {
  const x = tx ?? db;
  const [row] = await x.update(mmrJob)
    .set({ status: 'done', finishedDate: new Date(), errorMessage: null, updateDate: new Date() })
    .where(eq(mmrJob.id, jobId)).returning();
  if (!row) throw new SystemError(`mmr_job ${jobId} not found`, 404);
  return row;
}

// attempts < MAX → wait 환원(자동 재시도), 초과 → fail
async markFail(jobId: number, errorMessage: string, tx?: TransactionType): Promise<{ row: MmrJob; retried: boolean }> {
  const x = tx ?? db;
  const [cur] = await x.select().from(mmrJob).where(eq(mmrJob.id, jobId));
  if (!cur) throw new SystemError(`mmr_job ${jobId} not found`, 404);
  const retried = cur.attempts < MAX_ATTEMPTS;
  const [row] = await x.update(mmrJob)
    .set({
      status: retried ? 'wait' : 'fail',
      errorMessage,
      finishedDate: retried ? null : new Date(),  // 재시도면 종료시각 비움
      updateDate: new Date(),
    })
    .where(eq(mmrJob.id, jobId)).returning();
  return { row, retried };
}
```

> `attempts`는 픽업 때 이미 증가. 3번째 픽업(`attempts=3`)에서 실패하면 `3 < 3` 거짓 → `fail`. 결과적으로 **총 3회 시도**.

### 3.4 운영자용 (step11에서 노출)

```ts
// wait/run → cancel
async cancelJob(jobId: number): Promise<MmrJob> { /* status IN ('wait','run') 만 허용, 아니면 409 */ }

// fail/cancel → wait 재배치. attempts=0 리셋 → 다시 MAX회 기회 부여
async retryJob(jobId: number): Promise<MmrJob> {
  const [row] = await db.update(mmrJob)
    .set({ status: 'wait', scheduledDate: new Date(), attempts: 0, startedDate: null, finishedDate: null, errorMessage: null, updateDate: new Date() })
    .where(and(eq(mmrJob.id, jobId), inArray(mmrJob.status, ['fail', 'cancel']))).returning();
  if (!row) throw new SystemError(`mmr_job ${jobId} not retryable`, 409);
  return row;
}

async listJobs(filter): Promise<MmrJob[]> { /* jobType/status/guildId 필터, create_date DESC */ }
async getJobById(jobId: number): Promise<MmrJob | null> { /* 단건 */ }
```

> **`retryJob`는 `attempts=0` 리셋** — 운영자가 "다시 시도"를 누르면 자동 재시도 카운트가 소진된 상태라도 새로 MAX회 기회를 줘야 의미가 있다. (자동 재시도와 구분)

---

## 4. mmrWorker.ts (골격)

```ts
export type MmrJobHandler = (job: MmrJob) => Promise<void>;

export class MmrWorker {
  private handlers = new Map<MmrJobType, MmrJobHandler>();

  registerHandler(jobType: MmrJobType, handler: MmrJobHandler): void { this.handlers.set(jobType, handler); }

  // 한 tick: 최대 N개 픽업·처리. 동시성은 pickNextJob의 SKIP LOCKED + per-guild NOT EXISTS에 위임.
  async tick(opts: { maxJobs?: number } = {}): Promise<{ picked: number; processed: number; failed: number }> {
    const max = opts.maxJobs ?? 5;
    let picked = 0, processed = 0, failed = 0;
    for (let i = 0; i < max; i += 1) {
      const job = await db.transaction((tx) => mmrJobService.pickNextJob(tx)); // 짧은 픽업 TX
      if (!job) break;
      picked += 1;
      const handler = this.handlers.get(job.jobType as MmrJobType);
      if (!handler) { await mmrJobService.markFail(job.id, `no handler for ${job.jobType}`); failed += 1; continue; }
      try {
        await handler(job);                 // 픽업 TX 밖. 핸들러가 자체 TX로 결과 저장(step09).
        await mmrJobService.markDone(job.id);
        processed += 1;
      } catch (e) {
        await mmrJobService.markFail(job.id, e instanceof Error ? e.message : String(e));
        failed += 1;
      }
    }
    return { picked, processed, failed };
  }
}
export const mmrWorker = new MmrWorker();
```

**핸들러는 누가 등록하나** (이 step 밖):

| job_type | 핸들러 등록 | 트리거(enqueue) |
|---|---|---|
| `INCREMENTAL_BATCH` | step08 | step08 cron(30분)이 wait+1h 경기 있는 길드별로 enqueue |
| `RECALC` | step08(=incremental 반복) / step09 | (재)구독 시에만(step07). 삭제는 역산 롤백(step14) |
| `CLEANUP` | step12 | daily cron(step12) |

> **RECALC 멱등 재시작**([01 §3.3](../01_architecture.md)): RECALC 핸들러는 재시도 시 summary 초기화부터 전량 재실행하도록 step08/09에서 구현. 큐는 단지 "다시 wait→run"만 한다.

---

## 5. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| mmr_job 유지 | 확정. 동시성·재시도·관측을 한 곳에 모음 |
| job_type | `INCREMENTAL_BATCH`/`RECALC`/`CLEANUP` 3종. BASELINE 제외(동기 admin API) |
| `max_attempts` | **컬럼 아님 → config `MMR_JOB_MAX_ATTEMPTS`(=3)**. `attempts`만 컬럼 |
| `calculation_id`/`payload` 없음 | mmr_job에 두지 않음(컬럼 검토 제거). 경기별 calc_id는 result/queue가 가짐 |
| 핸들러 실행 위치 | 픽업 TX **밖**. gmok HTTP 동안 DB 락·커넥션 점유 회피 |
| markDone 시그니처 | calculationId 인자 없음(제거됨) |
| retryJob | `attempts=0` 리셋(운영자 수동), 자동 재시도(markFail)와 구분 |
| id 타입 | `serial` → `number` |

---

## 6. 완료 기준 (DoD)

- [ ] `enqueueJob` → status=wait 행 생성
- [ ] `pickNextJob`: wait+scheduled 도래 잡 1건을 run 전환, attempts+1, started_date 기록
- [ ] 같은 길드 INCREMENTAL_BATCH가 run 중이면 그 길드 wait 잡은 **픽업 안 됨**(다른 길드는 픽업됨)
- [ ] 동시 picker 2개가 같은 잡을 중복 픽업하지 않음(SKIP LOCKED)
- [ ] 핸들러 throw 시: attempts<3 → wait 환원, =3 → fail
- [ ] 핸들러 미등록 job_type → markFail
- [ ] `cancelJob`(wait/run만), `retryJob`(fail/cancel만, attempts=0) 동작
- [ ] `tick`이 maxJobs 한도 내에서 픽업·처리·집계 반환

---

## 7. 의존성 / 다음 step

- **선행**: [step02](./step02_schema.md)(mmr_job 타입)
- **후행**: [step08](./step08_incremental_worker.md)(INCREMENTAL_BATCH 핸들러 + 30분 cron) · [step09](./step09_result_save.md)(핸들러 내 결과 저장) · [step11](./step11_admin_api.md)(cancel/retry/list 노출) · [step12](./step12_crons.md)(CLEANUP·daily RECALC enqueue)
</content>
