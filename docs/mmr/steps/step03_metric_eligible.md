# step03 — mmr_participant_metric 생성 + is_mmr_eligible 판정

> 상위 문서: [00_overview §3.2](../00_overview.md) | [01_architecture §3.1](../01_architecture.md) | [02_data_model §2.6](../02_data_model.md)
> 선행: [step02_schema.md](./step02_schema.md) | 다음: [step04_baseline.md](./step04_baseline.md)

---

## 1. 목적 / 범위

리플레이 업로드 시 **모든 길드 경기에** 정제 데이터(`mmr_participant_metric`)를 만들고(통계/MMR 공통), 경기가 MMR 계산에 적합한지(`is_mmr_eligible`) 판정한다. **구독 길드인 경우에만** `mmr_match_queue`에 `wait`/`skip`으로 등록(=MMR 계산 대상).

**이 step의 책임은 여기까지다 — MMR 계산은 하지 않는다.** 계산은 worker(step08)가 1시간 뒤 가져간다.

### 범위에 포함
- **metric 생성: 모든 길드** (구독 게이트 밖)
- `replay.raw_data`에서 raw 49 + 파생 14 조립(categoricals·championId는 `match_participant` 변환값 재사용)
- `is_mmr_eligible` 판정 (per-row) + 경기 단위 적격성 (구조 검증)
- **구독 active 길드만** `mmr_match_queue` 초기 등록 (`wait`/`skip`)
- 업로드 facade hook
- **기존 경기 metric backfill** (일회성) — §7

### 범위 밖 (후속 step)
- gmok_mmr 호출·결과 저장 → step06·step09

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/guildSubscription.service.ts` | 신규 — `isMmrActive` |
| `src/services/mmrParticipantMetric.service.ts` | 신규 — eligible 판정 + metric 빌드/insert |
| `src/services/mmrMatchQueue.service.ts` | 신규 — `insertInitialStatus` (wait/skip) |
| `src/facade/replaySave.facade.ts` | 수정 — `saveMatchData` 끝에 MMR hook |

---

## 2. 업로드 흐름에서의 위치

```
saveMatchData(rawData, savedReplay, tx)
  riotAccount upsert
  customMatch insert            → insertedCustomMatch (createDate 캡처 필요)
  matchParticipant insert       → insertedParticipants (id 보유, 캡처 필요)
  guildMember insert
  ───────── MMR hook (이 step) ─────────
  // 1) metric 생성: 모든 길드 (구독 게이트 밖)
  metricRows = build(rawData, insertedParticipants, ... , playedDate=insertedCustomMatch.createDate)
  insertMetrics(metricRows, tx)
  // 2) MMR 계산 대상 등록: 구독 active 길드만
  if guildSubscription.isMmrActive(guildId, tx):
       eligible = isMatchEligibleForMmr(metricRows)
       mmrMatchQueue.insertInitialStatus({..., status: eligible ? 'wait' : 'skip'}, tx)
```

> 현재 facade는 `insertCustomMatch`·`insertMatchParticipants`의 반환을 캡처하지 않는다. **두 반환을 변수로 받도록 수정**한다(아래 §5).
> **metric은 모든 길드에 생성**(통계/MMR 공통). `mmr_match_queue` 등록만 구독 길드 게이트 → 비구독 길드는 metric만 쌓이고 MMR 계산은 안 됨.

---

## 3. is_mmr_eligible 판정 ([02_data_model §2.6](../02_data_model.md))

### 3.1 per-row 판정 (`judgeIsMmrEligible`)

각 참가자 row가 MMR에 쓰여도 되는지. **`mmr_participant_metric.is_mmr_eligible` 컬럼에 저장**된다.

```ts
const MIN_TIME_PLAYED_SECONDS = 300;        // 5분 미만 경기 제외
const SURRENDER_MIN_SECONDS  = 900;         // 15분 미만 '항복' 경기 제외 (정상 종료는 무관)

judgeIsMmrEligible(args: {
  timePlayed: number; totalDamageChampions: number; kill: number; assist: number;
  endedInSurrender: boolean;                // rawData GAME_ENDED_IN_SURRENDER === '1'
}): boolean {
  if (args.timePlayed < MIN_TIME_PLAYED_SECONDS) return false;            // 5분 미만
  if (args.endedInSurrender && args.timePlayed < SURRENDER_MIN_SECONDS) return false; // 15분 미만 항복
  if (args.totalDamageChampions === 0 && args.kill + args.assist === 0) return false; // AFK 의심
  return true;
}
```

> **항복 규칙**: `GAME_ENDED_IN_SURRENDER='1'`이고 `time_played < 900`(15분)인 경기만 제외. 15분 이후 항복·정상 종료는 정상 집계(`time_played`로 판정해 모호함 없음). 10명이 같은 값을 가지므로 per-row false가 그대로 경기 `skip`으로 전파된다.

### 3.2 경기 단위 적격성 (`isMatchEligibleForMmr`)

경기 전체가 MMR 계산 대상인지. **컬럼이 아니라 `mmr_match_queue.status` 결정에만 쓰인다.**

```ts
const POSITIONS = ['TOP', 'JUG', 'MID', 'ADC', 'SUP'] as const;

isMatchEligibleForMmr(rows: InsertMmrParticipantMetric[]): boolean {
  if (rows.length !== 10) return false;                       // 정확히 10명
  if (!rows.every((r) => r.isMmrEligible !== false)) return false; // 1명이라도 per-row false면 skip
  // 비정상 포지션 구조: 5포지션 각 2명이어야 함
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.position, (counts.get(r.position) ?? 0) + 1);
  return POSITIONS.every((p) => counts.get(p) === 2);
}
```

| 판정 결과 | `mmr_match_queue.status` |
|---|---|
| `isMatchEligibleForMmr === true` | `wait` (1시간 뒤 worker 처리 대상) |
| `false` (per-row 부적격 / 구조 비정상 / 10명 아님) | `skip` |

> **운영자 수동 제외**(02 §2.6 기준 4번)는 업로드 시점엔 없다. 관리자 API(step11)에서 특정 경기를 `skip` 처리하는 경로로 다룬다.

---

## 4. metric row 빌드 (`buildMetricRows`)

> 구조·필드 매핑·파생 산식의 **canonical 기준 = [match_participant_metric_table_spec.md](../match_participant_metric_table_spec.md) + [backfill SQL](../backfill_match_participant_metric.sql)**. 업로드 build와 backfill SQL은 **같은 결과**를 내야 한다(둘 다 `raw_data` 기준).

### 4.1 데이터 출처

| 출처 | 컬럼 |
|---|---|
| **rawData (참가자 원본)** | `puuid`(=`PUUID`) + **raw 49개** 전부(정의서 §2.2 JSON 키, 예 `CHAMPIONS_KILLED→kills`, `TIME_PLAYED→game_duration`) |
| 변환(categoricals) | `game_team`(`TEAM 100→blue/200→red`), `position`(`TEAM_POSITION JUNGLE→JUG…`), `game_result`(`WIN='Win'→1`) — `match_participant` 매핑 재사용(backfill SQL CASE와 동일 결과) |
| `champion_id` | `SKIN`→champion. `match_participant.championId` 재사용 |
| 파생 14개 | raw에서 계산(§4.3) |
| 인자 | `custom_match_id`, `guild_id`, `season`, `played_date` |
| 판정 | `is_mmr_eligible`(§3) |

> **`match_participant_id`는 더 이상 저장하지 않는다**(자연키 `(custom_match_id, puuid)`). 단 categoricals/championId는 이미 매핑된 `match_participant`(순서 매칭)를 **재사용**해 매퍼 중복을 피한다. raw 49개·파생은 rawData에서 직접.

### 4.2 매칭 — 순서 + PUUID 안전검사

`parsedMatchParticipant`가 `validatedData`를 **순서대로** 매핑하고 `.returning()`도 순서를 보존하므로, `rawData[i]` ↔ `insertedParticipants[i]`가 대응한다. 각 인덱스에서 `rawData[i].PUUID` 정합성을 확인하고 어긋나면 throw한다.

```ts
// raw 49개: metric 컬럼 ← JSON 키 (정의서 §2.2 전체)
const RAW_KEY_MAP = {
  kills: 'CHAMPIONS_KILLED', deaths: 'NUM_DEATHS', assists: 'ASSISTS',
  doubleKills: 'DOUBLE_KILLS', /* …triple/quadra/penta/sprees… */
  goldEarned: 'GOLD_EARNED', ccTime: 'TIME_CCING_OTHERS', gameDuration: 'TIME_PLAYED',
  damageToChampions: 'TOTAL_DAMAGE_DEALT_TO_CHAMPIONS', damageTaken: 'TOTAL_DAMAGE_TAKEN',
  wardsPlaced: 'WARD_PLACED', wardsKilled: 'WARD_KILLED', /* …정의서 §2.2 나머지 전부… */
} as const;  // ⚠️ 키명은 backfill SQL과 한 글자도 어긋나지 않게(WARD_PLACED 등)

const toIntOrNull = (v?: string | null) => { const n = parseInt(v ?? '', 10); return Number.isNaN(n) ? null : n; };

buildMetricRows(input): InsertMmrParticipantMetric[] {
  const { rawData, matchParticipants, customMatchId, guildId, season, playedDate } = input;
  if (rawData.length !== matchParticipants.length) throw new SystemError('metric build mismatch: length', 500);

  // 1) row별 raw + categoricals + 식별
  const rows = matchParticipants.map((mp, i) => {
    const p = rawData[i] as Record<string, string | undefined>;
    if (!p.PUUID) throw new SystemError('metric build mismatch: PUUID alignment', 500);
    const raw = Object.fromEntries(
      Object.entries(RAW_KEY_MAP).map(([col, key]) => [col, toIntOrNull(p[key])]),
    );
    return {
      customMatchId, guildId, season, puuid: p.PUUID, playedDate,
      championId: mp.championId, gameTeam: mp.gameTeam, position: mp.position,  // 변환값 재사용
      gameResult: mp.gameResult === '승' ? 1 : 0,
      ...raw,
      isMmrEligible: this.judgeIsMmrEligible({
        timePlayed: raw.gameDuration ?? 0, totalDamageChampions: raw.damageToChampions ?? 0,
        kill: raw.kills ?? 0, assist: raw.assists ?? 0,
        endedInSurrender: p.GAME_ENDED_IN_SURRENDER === '1',   // metric 컬럼엔 저장 안 함, 판정용
      }),
    };
  });

  // 2) 파생 14개 계산 (§4.3) — lane_gold_diff는 같은 경기 10행을 position별로 묶어 계산
  return addDerivedMetrics(rows);
}
```

### 4.3 파생지표 계산 (`addDerivedMetrics`)

[정의서 §3](../match_participant_metric_table_spec.md) / backfill SQL과 **수치가 정확히 일치**해야 한다. `분 = round(game_duration/60, 2)`, `deaths_safe = deaths||0 || 1`, 결과는 **2자리 반올림 + div0/NULL→0**.

```ts
// per-min = stat/분, kda=(kills+assists)/deaths_safe, dead_time_pct=time_spent_dead/(분*60)*100
// lane_gold_diff = gold_earned - (같은 경기·같은 position 상대들의 평균 gold_earned)
//   → rows를 position으로 그룹핑(정상 5v5면 그룹당 2명), 상대 평균과의 차
```

> **lane_gold_diff**: backfill은 윈도우(`PARTITION BY custom_match_id, position`), 업로드는 메모리의 10행을 position별 그룹으로 계산. 같은 정의(상대 평균 골드와의 차) → 동일 결과.

### 4.4 insert

```ts
async insertMetrics(rows: InsertMmrParticipantMetric[], tx: TransactionType) {
  if (rows.length === 0) return [];
  return tx.insert(mmrParticipantMetric).values(rows).returning();
}
```

> `UNIQUE(custom_match_id, puuid)` 충돌은 같은 경기 재처리가 아닌 한 발생하지 않는다(업로드당 1회). 충돌 시 throw → 상위에서 트랜잭션 롤백.

---

## 5. facade hook (`saveMatchData` 수정)

```ts
// customMatch / participant 반환 캡처
const insertedCustomMatch = await customMatchService.insertCustomMatch(customMatchData, tx);
const insertedParticipants = await matchParticipantService.insertMatchParticipants(
  rawData, customMatchData.id, tx, puuidToPlayerCodeMap,
);
await guildMemberService.insertGuildMember(riotAccounts, savedReplay.guildId, tx);

// ── MMR hook ──────────────────────────────
// 1) metric: 모든 길드 (구독 게이트 밖)
const metricRows = mmrParticipantMetricService.buildMetricRows({
  rawData,
  matchParticipants: insertedParticipants,
  customMatchId: customMatchData.id,
  guildId: savedReplay.guildId,
  season: savedReplay.season,
  // 실제 경기 시각 필드가 rawData(참가자 배열)에 없어 업로드 시각으로 대체.
  // 동일 시점 업로드는 같은 시각으로 묶이고, worker는 played_date ASC로 처리.
  playedDate: insertedCustomMatch.createDate,
});
await mmrParticipantMetricService.insertMetrics(metricRows, tx);

// 2) MMR 계산 대상 등록(mmr_match_queue): 구독 active 길드만
const isMmrActive = await guildSubscriptionService.isMmrActive(savedReplay.guildId, tx);
if (isMmrActive) {
  const eligible = mmrParticipantMetricService.isMatchEligibleForMmr(metricRows);
  await mmrMatchQueueService.insertInitialStatus(
    { customMatchId: customMatchData.id, guildId: savedReplay.guildId, season: savedReplay.season, status: eligible ? 'wait' : 'skip' },
    tx,
  );
}
```

**`guildSubscription.isMmrActive`**:
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

**`mmrMatchQueue.insertInitialStatus`**:
```ts
async insertInitialStatus(args: { customMatchId: string; guildId: string; season: string; status: 'wait' | 'skip' }, tx: TransactionType) {
  const [row] = await tx.insert(mmrMatchQueue).values(args).returning();
  return row;
}
```

---

## 6. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| metric 생성 범위 | **모든 길드** (구독 게이트 밖). 통계/MMR 공통 입력 |
| `mmr_match_queue` 등록 | **구독 active 길드만** = MMR 계산 대상. 비구독은 metric만 |
| 구조 기준 | [정의서](../match_participant_metric_table_spec.md) raw 49 + 파생 14. categoricals는 변환값(blue/red·enum·1/0) 저장 |
| 식별 | 자연키 `(custom_match_id, puuid)`. `match_participant_id` 미저장(전송 시 필요하면 join) |
| `played_date` | rawData에 게임 시각 없음 → `customMatch.createDate` 사용. 추후 raw 파서가 게임 시각 노출하면 그걸로 교체 |
| `game_result` 변환 | `match_participant.gameResult`(`'승'`/`'패'`) → metric `smallint`(1/0). backfill은 `WIN='Win'→1` |
| 파생 일치 | 업로드 `addDerivedMetrics`와 backfill SQL §3 **수치 동일**해야 함(per-min 단위·반올림·div0→0) |
| 순서 매칭 | `rawData[i]` ↔ `insertedParticipants[i]`. PUUID 정합성 검사로 어긋남 방지 |
| 부적격 경기도 metric 생성 | 생성함(데이터 보존). `is_mmr_eligible` 플래그 + (구독 길드면) queue `skip` |
| 트랜잭션 | 전부 업로드 tx 안에서 실행. 실패 시 업로드 전체 롤백 |
| 기존 경기 metric | 모든 길드 적재라 **구독 시 raw 재파싱 backfill 불필요**. 단 이 기능 배포 전 경기는 일회성 backfill SQL(§7) |

---

## 7. 기존 경기 metric backfill (일회성)

이 기능 배포 **이전에 업로드된 경기**는 `mmr_participant_metric`이 없다. 모든 길드 대상이므로, 일회성 **backfill SQL**로 채운다 → **[backfill_match_participant_metric.sql](../backfill_match_participant_metric.sql)**.

핵심:
- 원천은 **`replay.raw_data`(JSONB 배열)** — `jsonb_array_elements`로 참가자 펼침. (`match_participant` 조인 아님 → raw 49개 전부 충당)
- categoricals **변환**: `team 100→blue/200→red`, `position CASE`, `WIN='Win'→1` (업로드 build와 동일 결과)
- `champion_id`: `champion.champ_name_eng = SKIN` LEFT JOIN
- `puuid` = `PUUID` 키, `custom_match_id` = `replay.replay_code`, `guild_id`/`season` = `replay`
- `played_date` = `replay.create_date`
- 파생 14개는 §3 산식(반올림·div0→0·lane_gold_diff 윈도우)으로 같은 SQL에서 계산
- **멱등**: 이미 적재된 `custom_match_id` skip, `is_deleted=true` 리플 제외
- `is_mmr_eligible`은 §3 기준으로 SQL 조건 적용(또는 적재 후 일괄 UPDATE)

---

## 8. 완료 기준 (DoD)

- [ ] **비구독 길드 업로드**: metric 10행 생성 O, `mmr_match_queue` 미생성(MMR 계산 안 함)
- [ ] 구독 길드 정상 경기(10명·구조 정상·전원 적격): metric 10행 + `mmr_match_queue = wait`
- [ ] 구독 길드 부적격 경기(5분 미만 1명 등): metric 10행 + `mmr_match_queue = skip`
- [ ] 비정상 포지션 구조(JUG 2명·SUP 0명 등): `skip`
- [ ] metric의 `puuid`가 rawData PUUID와 일치, `game_result`가 1/0, `game_team`/`position` 변환값
- [ ] `UNIQUE(custom_match_id, puuid)` 보장 (업로드당 유저별 1행)
- [ ] 파생 14개가 backfill SQL §3 결과와 수치 일치(per-min·반올림·lane_gold_diff)
- [ ] 업로드 tx 실패 시 metric·queue도 롤백
- [ ] (backfill) 기존 경기 metric 일회성 적재 — [backfill SQL](../backfill_match_participant_metric.sql) 실행

---

## 9. 의존성 / 다음 step

- **선행**: [step01](./step01_migration.md)(테이블) · [step02](./step02_schema.md)(스키마 타입)
- **후행**: [step08](./step08_incremental_worker.md)(wait 경기 처리). 구독 RECALC는 metric 이미 적재라 backfill 불필요
</content>
