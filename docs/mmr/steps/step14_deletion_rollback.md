# step14 — 리플 삭제 MMR 롤백

> 상위 문서: [01_architecture §2-C, §3.4](../01_architecture.md) | [00_overview §3.3](../00_overview.md) | [02_data_model §2.8](../02_data_model.md)
> 선행: [step09](./step09_result_save.md) | 관련: [step11 §4](./step11_admin_api.md)(경기 수동 제외가 재사용)

---

## 1. 목적 / 범위

리플 삭제(soft delete) 시 그 경기의 MMR 영향을 **역산 롤백**하고 MMR 데이터를 `is_deleted=true`로 표시한다. **전체 RECALC 없음**([기획 결정](../00_overview.md)).

- 삭제는 **업로드 후 2주 이내**만 허용(config `REPLAY_DELETE_WINDOW_DAYS`=14, system_config). → 역산 누적 오차를 작게 묶는다.
- 기존 `matchParticipant.deleteMatch`(custom_match·match_participant·replay soft delete) 트랜잭션에 **MMR 롤백 hook** 추가.
- 관리자 "경기 수동 제외"([step11 §4](./step11_admin_api.md))도 이 롤백 서비스를 재사용(replay는 안 지움).

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/mmrDeletion.service.ts` | 신규 — `rollbackMatch(customMatchId, tx)` |
| `src/services/matchParticipant.service.ts` | 수정 — `deleteMatch`에 2주 가드 + MMR hook |
| config (system_config) | `REPLAY_DELETE_WINDOW_DAYS` = 14 |

---

## 2. deleteMatch 수정 ([matchParticipant.service.ts](src/services/matchParticipant.service.ts))

```ts
async deleteMatch(gameId, guildId) {
  return db.transaction(async (tx) => {
    // ── 2주 삭제 가능 기간 가드 ──
    const [cm] = await tx.select({ createDate: customMatch.createDate })
      .from(customMatch)
      .where(and(eq(customMatch.id, gameId), eq(customMatch.guildId, guildId), eq(customMatch.isDeleted, false)));
    if (!cm) return null;
    const windowDays = Number(await systemConfigService.getConfigOrDefault('REPLAY_DELETE_WINDOW_DAYS', '14'));
    if (Date.now() - cm.createDate.getTime() > windowDays * 86400_000) {
      throw new BusinessError(`삭제 가능 기간(${windowDays}일)이 지난 경기입니다`, 400);
    }

    // 1~3. custom_match / match_participant / replay soft delete (기존)
    ...

    // 4. ── MMR 롤백 hook (이 step) ──
    await mmrDeletionService.rollbackMatch(gameId, tx);

    return deletedMatch;
  });
}
```

> 가드는 soft delete **전에** 검사(초과 시 throw → 트랜잭션 롤백, 아무것도 안 지움).

---

## 3. `rollbackMatch(customMatchId, tx)`

metric은 **모든 길드**에 있고, queue/result/history는 **구독 길드만** 있다. 상태별 분기:

```ts
async rollbackMatch(customMatchId: string, tx: TransactionType): Promise<void> {
  // queue 유무 = MMR 계산 대상(구독 길드)이었는지
  const [q] = await tx.select().from(mmrMatchQueue)
    .where(and(eq(mmrMatchQueue.customMatchId, customMatchId), eq(mmrMatchQueue.isDeleted, false)))
    .for('update');

  // (a) done 경기였으면 → summary 역산
  if (q && q.status === 'done') {
    await this.reverseSummary(customMatchId, tx);
  }

  // (b) MMR 데이터 soft delete (있는 것만)
  await tx.update(mmrParticipantMetric).set({ isDeleted: true })
    .where(eq(mmrParticipantMetric.customMatchId, customMatchId));            // 모든 길드
  if (q) {
    await tx.update(mmrMatchQueue).set({ isDeleted: true }).where(eq(mmrMatchQueue.customMatchId, customMatchId));
    await tx.update(mmrMatchResult).set({ isDeleted: true }).where(eq(mmrMatchResult.customMatchId, customMatchId));
    await tx.update(mmrHistory).set({ isDeleted: true }).where(eq(mmrHistory.customMatchId, customMatchId));
  }
}
```

| 경우 | summary 역산 | metric | queue/result/history |
|---|---|---|---|
| 비구독 길드 (queue 없음) | — | is_deleted=true | (없음) |
| 구독 `wait` (미반영) | — | is_deleted=true | is_deleted=true |
| 구독 `done` (반영됨) | **O (§4)** | is_deleted=true | is_deleted=true |

---

## 4. `reverseSummary` — 역산 (done 경기)

`mmr_history`(현재 적용된 delta) ⋈ `mmr_match_result`(game_result)로 참가자별 summary를 되돌린다.

```ts
async reverseSummary(customMatchId, tx) {
  // history는 RECALC 시 wipe+재생성돼 '현재값'을 담음. game_result는 result 조인으로.
  const rows = await tx
    .select({ guildId: mmrHistory.guildId, season: mmrHistory.season,
              puuid: mmrHistory.puuid, position: mmrHistory.position,
              mmrDelta: mmrHistory.mmrDelta, gameResult: mmrMatchResult.gameResult })
    .from(mmrHistory)
    .innerJoin(mmrMatchResult, eq(mmrMatchResult.id, mmrHistory.mmrMatchResultId))
    .where(and(eq(mmrHistory.customMatchId, customMatchId), eq(mmrHistory.isDeleted, false)));

  for (const r of rows) {              // r: guildId, season, puuid, position, mmrDelta, gameResult(1/0)
    // 해당 포지션 컬럼 역산: {pos}_mmr -= mmrDelta, {pos}_games -= 1, {pos}_wins -= gameResult
    // 그 후 total_mmr = Σ(pos_mmr × pos_games) / Σ(pos_games)  (games>0 포지션만)
    //      total_games -= 1, total_wins -= gameResult
    await summaryService.applyReverse(r, tx);   // guild_id+season+puuid 행 UPDATE
  }
}
```

**역산 식** (포지션 `P`, 변동량 `d`, 승패 `w`):
```
{P}_mmr   -= d
{P}_games -= 1
{P}_wins  -= w
total_games -= 1
total_wins  -= w
total_mmr  = round( Σ(pos_mmr × pos_games) / Σ(pos_games) )   -- games>0 포지션만
```

> **근사 역산**: 삭제 경기 이후 경기들은 보정하지 않는다. 2주 삭제 제한으로 이후 경기가 적어 오차가 작다([01 §2-C](../01_architecture.md)). 전체 정확성이 필요하면 (재)구독 RECALC가 처음부터 다시 계산.

---

## 5. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 삭제 기간 | 업로드(`custom_match.create_date`) 후 `REPLAY_DELETE_WINDOW_DAYS`(=14) 이내. 초과 시 400 |
| 롤백 방식 | 역산(history⋈result), 전체 RECALC 없음 |
| `game_result` | history에 중복 저장 안 함 → `mmr_match_result_id` 조인 |
| soft delete | metric/queue/result/history `is_deleted=true`. 30일 후 cleanup이 hard delete([step12](./step12_crons.md)) |
| 복구 | 없음 (soft delete는 audit·유예용) |
| 트랜잭션 | deleteMatch tx 안에서 실행 → replay 삭제와 원자적 |
| 비구독 길드 | metric만 is_deleted=true (queue 없으니 summary 영향 없음) |
| summary는 soft delete 안 함 | 누적값이라 행을 지우는 게 아니라 역산으로 되돌림 |
| 동시성 | queue `FOR UPDATE`로 잠금 — worker 처리와 경합 시 한쪽만 |
| 경기 수동 제외 재사용 | [step11 §4](./step11_admin_api.md)가 `rollbackMatch` 호출(단 replay/custom_match은 안 지움) |

---

## 6. 완료 기준 (DoD)

- [ ] 2주 초과 경기 삭제 시도 → 400, 아무것도 안 지워짐(트랜잭션 롤백)
- [ ] 비구독 길드 경기 삭제 → metric만 `is_deleted=true`
- [ ] 구독 `wait` 경기 삭제 → metric·queue `is_deleted=true`, summary 변화 없음
- [ ] 구독 `done` 경기 삭제 → summary 역산(pos_mmr·games·wins·total 정확히 차감) + metric/queue/result/history `is_deleted=true`
- [ ] 역산 후 조회/리더보드/이력에서 그 경기 제외됨(is_deleted 필터)
- [ ] deleteMatch tx 실패 시 전부 롤백
- [ ] 경기 수동 제외(step11)가 같은 롤백 재사용

---

## 7. 의존성

- **선행**: [step02](./step02_schema.md)(is_deleted 컬럼) · [step09](./step09_result_save.md)(summary/history 구조) · `systemConfigService`
- **연관**: [step11 §4](./step11_admin_api.md)(경기 제외) · [step12](./step12_crons.md)(soft delete분 cleanup)
</content>
