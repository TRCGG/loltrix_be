# step09 — 결과 저장 (멱등 upsert + 단일 트랜잭션)

> 상위 문서: [03_api_contract §5.2](../03_api_contract.md) | [01_architecture §3.2](../01_architecture.md)
> 선행: [step08](./step08_incremental_worker.md) | 다음: [step10_query_api.md](./step10_query_api.md)

---

## 1. 목적 / 범위

gmok_mmr 단일 경기 응답(`MatchCalcResponse`)을 **하나의 트랜잭션으로 멱등하게 저장**한다. step08 `processMatch`가 호출하는 `mmrResultSave.save(res)`의 본체.

저장 대상 4가지([03 §5.2](../03_api_contract.md)):

| 응답 필드 | 테이블 | 방식 |
|---|---|---|
| `match_results` | `mmr_match_result` | UPSERT (`calculation_id, match_participant_id`) |
| `mmr_history` | `mmr_history` | INSERT (append) |
| `updated_user_summary` | `mmr_member_summary` | UPSERT (`guild_id, season, puuid`) |
| — | `mmr_match_queue` | UPDATE `status = done` |

**전부 단일 TX.** 하나라도 실패하면 롤백 → 경기는 `wait`로 남아 재처리.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/services/mmrResultSave.service.ts` | 신규 — `save(res)` |

---

## 2. 멱등성 — 왜 재처리 가드가 필요한가

세 저장의 멱등 특성이 다르다:

| 테이블 | 재적용 시 | 멱등? |
|---|---|---|
| `mmr_match_result` | UNIQUE(calc_id, mpid) upsert → 같은 값 덮어씀 | ✅ |
| `mmr_member_summary` | gmok이 **절댓값**(누적 결과)을 줌 → upsert로 덮어씀 | ✅ |
| `mmr_history` | **append-only, 멱등 키 없음** → 재INSERT = **중복 row** | ❌ |

→ `mmr_history` 때문에 **재처리 가드가 필수**다. 가드 = "이 경기가 이미 done이면 통째로 skip".

### 가드 메커니즘

```
save(res)  ── 단일 TX ──
  q = SELECT * FROM mmr_match_queue WHERE custom_match_id = ? FOR UPDATE   -- 행 잠금
  if (q.is_deleted) return                -- 처리 중 삭제됨 → 저장 안 함
  if (q.status === 'done') return        -- 이미 저장됨(크래시 재시도·중복 tick) → skip, 중복 history 방지
  if (q.status !== 'wait') return         -- skip/fail 등은 처리 안 함
  ... (아래 저장) ...
  UPDATE mmr_match_queue SET status='done', update_date=now WHERE custom_match_id = ?
COMMIT
```

- `queue=done` 전환이 **같은 TX**에 포함되므로, 커밋된 저장은 항상 `done`과 원자적. 따라서 재시도가 done을 보면 안전하게 skip.
- 크래시로 커밋 전 중단 → 전체 롤백(queue 여전히 wait) → 재시도 시 새 `calculation_id`로 정상 저장. 롤백된 이전 시도의 result/history는 남지 않음.
- per-guild 직렬화(step05)로 동시 처리는 원래 없지만, 가드가 **크래시·중복 tick**까지 막는다.

---

## 3. 저장 순서 (가드 통과 후, 같은 TX)

```ts
async save(res: MatchCalcResponse): Promise<void> {
  await db.transaction(async (tx) => {
    // 0) 재처리 가드
    const [q] = await tx.select().from(mmrMatchQueue)
      .where(eq(mmrMatchQueue.customMatchId, res.custom_match_id)).for('update');
    if (!q || q.isDeleted || q.status !== 'wait') return;   // 삭제/done/skip/fail → no-op

    // 1) mmr_match_result UPSERT — returning으로 id 확보 (history 연결용)
    const resultRows = res.match_results.map(r => ({
      calculationId: res.calculation_id, baselineVersion: res.baseline_version,
      guildId: res.guild_id, season: res.season, customMatchId: res.custom_match_id,
      matchParticipantId: r.match_participant_id, puuid: r.puuid, position: r.position,
      gameResult: r.game_result, preGameMmr: r.pre_game_mmr, mmrChange: r.mmr_change, postGameMmr: r.post_game_mmr,
      expectedScore: String(r.expected_score), actualScore: String(r.actual_score),       // numeric ← string
      relativeFactor: String(r.relative_factor), personalFactor: String(r.personal_factor), finalFactor: String(r.final_factor),
    }));
    const savedResults = await tx.insert(mmrMatchResult).values(resultRows)
      .onConflictDoUpdate({ target: [mmrMatchResult.calculationId, mmrMatchResult.matchParticipantId], set: { /* 모든 값 */ } })
      .returning();

    // 2) history → result id 매핑 (puuid+position 1:1) 후 INSERT
    const resultIdByKey = new Map(savedResults.map(s => [`${s.puuid}:${s.position}`, s.id]));
    const historyRows = res.mmr_history.map(h => ({
      guildId: res.guild_id, season: res.season, puuid: h.puuid, customMatchId: res.custom_match_id, position: h.position,
      mmrDelta: h.mmr_delta, beforeMmr: h.before_mmr, afterMmr: h.after_mmr,
      beforePosMmr: h.before_pos_mmr, afterPosMmr: h.after_pos_mmr,
      mmrMatchResultId: resultIdByKey.get(`${h.puuid}:${h.position}`)!,    // FK 아님(논리참조), 매핑 보장
      // create_date 기본 now → 파티션 라우팅
    }));
    await tx.insert(mmrHistory).values(historyRows);

    // 3) mmr_member_summary UPSERT — 절댓값 덮어쓰기
    for (const u of res.updated_user_summary) {
      const row = buildSummaryRow(res.guild_id, res.season, u);   // total_* + 포지션별 15컬럼 + is_deleted=false
      await tx.insert(mmrMemberSummary).values(row)
        .onConflictDoUpdate({ target: [mmrMemberSummary.guildId, mmrMemberSummary.season, mmrMemberSummary.puuid], set: { /* 모든 값, is_deleted=false */ } });
    }

    // 4) queue = done
    await tx.update(mmrMatchQueue).set({ status: 'done', updateDate: new Date() })
      .where(eq(mmrMatchQueue.customMatchId, res.custom_match_id));
  });
}
```

### `buildSummaryRow` — updated_user_summary → 평면 컬럼
응답의 `positions: [{position, pos_mmr, pos_games, pos_wins}]`를 `top_*`/`jug_*`/`mid_*`/`adc_*`/`sup_*` 15컬럼으로 펼친다. 응답에 없는 포지션은 기본(`1300/0/0`) — gmok이 절댓값 전체를 주므로 없는 포지션은 미플레이로 간주. `total_mmr/total_games/total_wins`는 응답값, `is_deleted=false`.

---

## 4. 주의점

| 항목 | 내용 |
|---|---|
| `numeric` 저장 | Drizzle `numeric`은 string 추론 → `expected_score` 등은 `String(n)`으로 넣음 |
| history 연결 | `mmr_history.mmr_match_result_id` = 같은 (puuid, position) result row의 `id`. 매핑 누락 시 throw(가정 위반) |
| history 멱등 | 멱등 키 없음 → **가드로만** 중복 방지. 가드 우회 INSERT 금지 |
| summary 절댓값 | gmok이 누적 결과 절댓값을 주므로 delta 가산 ❌, 덮어쓰기 ✅ (멱등) |
| is_deleted | summary upsert 시 항상 `false`로(재구독/정상 처리 시 활성화) |
| queue 상태 | `wait`만 처리. `done`이면 skip(가드), `skip/fail`이면 no-op |
| TX 경계 | gmok 호출은 이 함수 **밖**(step08). 여기선 순수 DB |
| 부분 실패 | 어느 단계든 throw → 전체 롤백 → queue wait 유지 → 재처리 |

---

## 5. 완료 기준 (DoD)

- [ ] 정상 경기: result 10 upsert + history 10 insert + summary 10 upsert + queue=done, 모두 한 TX
- [ ] 같은 응답 재호출(가드): queue가 이미 done → **no-op** (history 중복 INSERT 안 됨)
- [ ] 중간 단계 throw 시 전체 롤백, queue=wait 유지
- [ ] `mmr_history.mmr_match_result_id`가 같은 (puuid, position)의 result id와 일치
- [ ] summary가 응답 절댓값으로 덮어써짐(가산 아님), is_deleted=false
- [ ] numeric 필드 정상 저장(소수 4자리)

---

## 6. 의존성 / 다음 step

- **선행**: [step02](./step02_schema.md)(테이블 타입) · [step06](./step06_mmr_client.md)(`MatchCalcResponse` 타입) · [step08](./step08_incremental_worker.md)(호출자)
- **후행**: [step10](./step10_query_api.md)(저장된 summary/history 조회)
</content>
