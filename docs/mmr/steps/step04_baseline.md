# step04 — mmr_season_baseline 서비스

> 상위 문서: [01_architecture §2-D](../01_architecture.md) | [02_data_model §2.3](../02_data_model.md) | [03_api_contract §4](../03_api_contract.md)
> 선행: [step02_schema.md](./step02_schema.md) | 다음: [step05_job_queue.md](./step05_job_queue.md)

---

## 1. 목적 / 범위

`mmr_season_baseline`의 **저장 / 조회 / active 전환** DB 서비스. baseline은 시즌별 전체 길드 통합 1개이고, **시즌당 active 1개**만 존재한다(partial unique).

**이 step은 DB CRUD만 책임진다.**
- gmok_mmr `baselines/calculate` **호출**은 [step06](./step06_mmr_client.md) 클라이언트.
- baseline 계산 **트리거**(관리자 동기 admin API) + 호출→저장 **오케스트레이션**은 [step11](./step11_admin_api.md).
- 즉 step11이 "gmok 호출 → 응답을 이 서비스의 `saveBaseline`에 저장" 순으로 엮는다.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/mmrSeasonBaseline.service.ts` | 신규 — save / get / activate |

---

## 2. baseline의 위치 ([03 §4](../03_api_contract.md))

```
관리자 동기 API (step11)
  └─ gmok POST /v1/mmr/baselines/calculate  (step06)
       응답: { season, baseline_version, mmr_baseline, game_impact_baseline, metadata }
       └─ mmrSeasonBaseline.saveBaseline(...)   ← 이 step
            (필요 시 activate=true 로 즉시 active 전환)

이후 incremental/RECALC worker (step08)
  └─ mmrSeasonBaseline.getActiveBaseline(season)
       → mmr_baseline + game_impact_baseline 을 matches/calculate payload에 실음
```

baseline이 없으면 worker는 경기를 `fail`이 아니라 `wait`로 둔다([01 §2-D](../01_architecture.md)). 그 분기는 step08에서 `getActiveBaseline === null` 체크로 구현한다.

---

## 3. 응답 → 컬럼 매핑

gmok 응답([03 §4.2](../03_api_contract.md))을 `mmr_season_baseline` 행으로 저장한다.

| gmok 응답 | 컬럼 | 비고 |
|---|---|---|
| `season` | `season` | |
| `baseline_version` | `baseline_version` | loltrix가 생성해 요청에 넣은 값이 그대로 반환됨 |
| `mmr_baseline` | `mmr_baseline` (jsonb) | `{ f1_mean, f2_mean }` |
| `game_impact_baseline` | `game_impact_baseline` (jsonb) | `{ position_weights, outcome_stats }` |
| `metadata.match_count` / `metadata.player_game_row_count` | `metadata` (jsonb) | **`{ match_count, row_count }`** 로 슬림하게 저장. `calculated_at`은 버림(create_date로 갈음) |
| — | `is_active` | `activate` 인자에 따라 |
| — | `create_date` | 자동(=계산 반영 시각) |

> baseline 데이터 구조 안정성 정책([03 §8](../03_api_contract.md)): `mmr_baseline`/`game_impact_baseline`은 키 추가만 허용, 제거·이름변경 금지. jsonb라 스키마 변경 없이 수용.

---

## 4. 서비스 정의

```ts
export interface SaveBaselineInput {
  season: string;
  baselineVersion: string;
  mmrBaseline: Record<string, unknown>;        // { f1_mean, f2_mean }
  gameImpactBaseline: Record<string, unknown>; // { position_weights, outcome_stats }
  metadata?: Record<string, unknown>;          // { match_count, row_count }
  activate?: boolean;                          // true면 저장과 동시에 시즌 active 전환
}
```

### 4.1 saveBaseline — 저장 (+ 선택적 active 전환)

```ts
async saveBaseline(input: SaveBaselineInput, tx?: TransactionType): Promise<MmrSeasonBaseline> {
  const run = async (x: TransactionType): Promise<MmrSeasonBaseline> => {
    if (input.activate) await this.deactivateAllInSeason(input.season, x); // partial unique 회피
    const [row] = await x.insert(mmrSeasonBaseline).values({
      season: input.season,
      baselineVersion: input.baselineVersion,
      mmrBaseline: input.mmrBaseline,
      gameImpactBaseline: input.gameImpactBaseline,
      metadata: input.metadata ?? {},
      isActive: input.activate === true,
    }).returning();
    return row;
  };
  return tx ? run(tx) : db.transaction(run);
}
```

> 같은 `(season, baseline_version)` 재저장은 `UNIQUE` 위반 → throw. 매 계산은 새 버전을 쓴다.

### 4.2 activateBaseline — 기존 버전을 active로 전환

```ts
async activateBaseline(args: { season: string; baselineVersion: string }, tx?: TransactionType): Promise<MmrSeasonBaseline> {
  const run = async (x: TransactionType): Promise<MmrSeasonBaseline> => {
    await this.deactivateAllInSeason(args.season, x);              // 먼저 해제
    const [row] = await x.update(mmrSeasonBaseline)
      .set({ isActive: true })
      .where(and(eq(mmrSeasonBaseline.season, args.season), eq(mmrSeasonBaseline.baselineVersion, args.baselineVersion)))
      .returning();
    if (!row) throw new SystemError(`baseline not found: ${args.season}/${args.baselineVersion}`, 404);
    return row;
  };
  return tx ? run(tx) : db.transaction(run);
}

// 내부 helper — partial unique(시즌당 active 1개) 정합성 유지
private async deactivateAllInSeason(season: string, x: TransactionType): Promise<void> {
  await x.update(mmrSeasonBaseline).set({ isActive: false })
    .where(and(eq(mmrSeasonBaseline.season, season), eq(mmrSeasonBaseline.isActive, true)));
}
```

> **partial unique `(season) WHERE is_active`** 때문에 "새 것 active" 전에 **같은 트랜잭션에서 기존 active 해제**가 필수. 순서를 어기면 unique 위반.

### 4.3 조회

```ts
// worker가 matches/calculate payload 만들 때 사용. 없으면 null → 경기 wait 유지(step08).
async getActiveBaseline(season: string, tx?: TransactionType): Promise<MmrSeasonBaseline | null> {
  const x = tx ?? db;
  const [row] = await x.select().from(mmrSeasonBaseline)
    .where(and(eq(mmrSeasonBaseline.season, season), eq(mmrSeasonBaseline.isActive, true))).limit(1);
  return row ?? null;
}

async getBaselineByVersion(season: string, baselineVersion: string): Promise<MmrSeasonBaseline | null> { /* season+version 단건 */ }

async listBaselinesBySeason(season: string): Promise<MmrSeasonBaseline[]> { /* create_date DESC, 운영 화면용 */ }
```

---

## 5. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 시즌당 active 1개 | partial unique index가 강제. 전환은 **deactivate→activate를 한 TX**로 |
| 시즌 중 재계산 | 새 버전 저장. **과거 MMR은 유지**, 자동 RECALC 없음([00 §3.4](../00_overview.md)). 신규 경기만 새 active 적용 |
| baseline_version 생성 | loltrix가 `"YYYY-MM"` 등으로 생성해 gmok 요청에 넣음(step11). 응답에 그대로 반환 |
| metadata 슬림화 | `{ match_count, row_count }`만. gmok의 `calculated_at`은 저장 안 함 |
| 이 서비스의 비범위 | gmok 호출·트리거·데이터 조립은 step06/step11. 여기선 받은 응답을 저장/조회만 |
| 에러 | 활성화 대상 없음 → 404. 중복 버전 → unique throw → 상위 롤백 |

---

## 6. 완료 기준 (DoD)

- [ ] `saveBaseline(activate=true)`: 행 저장 + 해당 시즌 다른 active 전부 해제 + 이 행만 active
- [ ] 같은 시즌에 active 2개를 만들려 하면 partial unique 위반
- [ ] `activateBaseline`: 기존 active 해제 후 지정 버전 active. 없는 버전이면 404
- [ ] `getActiveBaseline`: 시즌 active 1건 반환, 없으면 null
- [ ] 중복 `(season, baseline_version)` 저장 시 throw
- [ ] `metadata`에 `match_count`·`row_count`만, `calculated_at` 미저장

---

## 7. 의존성 / 다음 step

- **선행**: [step01](./step01_migration.md)(테이블) · [step02](./step02_schema.md)(스키마 타입)
- **후행**: [step06](./step06_mmr_client.md)(gmok 호출) · [step08](./step08_incremental_worker.md)(`getActiveBaseline` 사용) · [step11](./step11_admin_api.md)(계산 트리거→저장 오케스트레이션)
</content>
