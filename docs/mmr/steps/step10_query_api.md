# step10 — MMR 조회 API

> 상위 문서: [00_overview §7](../00_overview.md) | [02_data_model §2.9, §2.8](../02_data_model.md)
> 선행: [step09](./step09_result_save.md) | 다음: [step11_admin_api.md](./step11_admin_api.md)

---

## 1. 목적 / 범위

길드원이 MMR을 조회하는 읽기 API. 모든 응답은 **구독/계산 상태 게이트**를 거쳐 `{ available, status, message, data }` 포맷([00 §7](../00_overview.md))으로 반환한다. 데이터 원천은 step09가 저장한 `mmr_member_summary`·`mmr_history`.

- **GET 라우트** → `decodeGuildId` 적용([API 컨벤션](../00_overview.md): GET만 디코딩).
- 권한 게이트 없음(컨벤션).
- **placement**: `total_games < N`이면 배치 중(`is_placed=false`) → 리더보드 분리.

### 산출물

| 파일 | 변경 |
|---|---|
| `src/routes/mmrQuery.routes.ts` | 신규 — GET 3종 (`decodeGuildId`) |
| `src/controllers/mmrQuery.controller.ts` | 신규 |
| `src/services/mmrQuery.service.ts` | 신규 — availability 게이트 + 조회 |
| `src/routes/index.ts` | 라우트 등록 |
| config | `MMR_PLACEMENT_GAMES`(=5) |

---

## 2. 공통 응답 게이트 ([00 §7](../00_overview.md))

```ts
// guild_subscription(구독했나) → mmr_guild_state(계산 됐나) 순으로 판정
async resolveAvailability(guildId, season): Promise<{ available: boolean; status: string; message: string }> {
  if (!(await guildSubscription.isMmrActive(guildId)))           // step03 재사용
    return { available: false, status: 'inactive', message: '이 길드는 MMR 기능을 사용하지 않습니다' };
  const state = await mmrGuildState.get(guildId, season);
  if (!state || state.status === 'wait_init')
    return { available: false, status: 'wait_init', message: 'MMR 초기 계산 진행 중입니다' };
  if (state.status === 'error')
    return { available: false, status: 'error', message: '일시적 처리 지연입니다' };
  return { available: true, status: 'ready', message: '' };      // ready
}
```

각 조회 핸들러:
```
const gate = await resolveAvailability(guildId, season);
if (!gate.available) return res.json({ ...gate, data: null });
const data = await ...조회...;
return res.json({ available: true, status: 'ready', message: '', data });
```

> `season`은 기본 `system_config.LOL_SEASON`(현재 시즌). 과거 시즌 조회는 query param `?season=` 허용([00 §3.4](../00_overview.md): 이전 시즌 조회 가능).

---

## 3. 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/mmr/guilds/:guildId/players/:puuid` | 개인 현재 MMR (total + 포지션별 + is_placed) |
| GET | `/api/mmr/guilds/:guildId/ranking` | 길드 리더보드 (배치 완료자, total_mmr DESC) |
| GET | `/api/mmr/guilds/:guildId/players/:puuid/history` | 개인 MMR 변동 이력(시계열) |

- `:guildId`는 base64 → `decodeGuildId`가 디코딩. `:puuid`는 그대로.
- query: `?season=`(선택, 기본 현재), `?position=`(ranking 필터), `?page/?limit`(ranking·history).

### 3.1 개인 MMR

```
data = {
  puuid, total_mmr, total_games, total_wins,
  overall_winrate,                       // total_wins/total_games (서버 계산, 미저장)
  is_placed,                             // total_games >= MMR_PLACEMENT_GAMES
  positions: [ { position, mmr, games, wins, winrate } ]   // games>0 포지션만
}
```
`mmr_member_summary` 1행을 펼쳐 구성. `is_deleted=true`면 게이트 단계 전에 없는 것으로 취급(또는 inactive).

### 3.2 리더보드

```sql
SELECT s.puuid, r.riot_name, r.riot_name_tag, s.total_mmr, s.total_games, s.total_wins
FROM mmr_member_summary s
JOIN riot_account r ON r.puuid = s.puuid           -- 표시명
WHERE s.guild_id = $1 AND s.season = $2
  AND s.is_deleted = FALSE
  AND s.total_games >= $MMR_PLACEMENT_GAMES        -- 배치 완료자만
ORDER BY s.total_mmr DESC
LIMIT $limit OFFSET $offset
```
- `is_deleted=false` + `total_games >= N`(배치 완료) → 리더보드 인덱스(`idx_mmr_member_summary_leaderboard`) 활용.
- `?position=`이면 해당 포지션 `{pos}_mmr DESC`로 정렬(배치 기준도 `{pos}_games >= N` 고려 가능 — v1은 total 기준).
- 배치 미완료자는 리더보드에서 제외(별도 "배치 중" 목록은 v1 스코프 밖, 필요 시 플래그로).

### 3.3 변동 이력

```sql
SELECT mmr_delta, before_pos_mmr, after_pos_mmr, position, custom_match_id, create_date
FROM mmr_history
WHERE guild_id = $1 AND season = $2 AND puuid = $3
  AND is_deleted = FALSE              -- 삭제 롤백된 경기 제외
ORDER BY create_date DESC
LIMIT $limit OFFSET $offset
```
- 그래프·이력 화면용. monthly 파티션 + 인덱스(`guild, season, puuid, create_date DESC`) 활용.
- 산식 상세가 필요하면 `mmr_match_result_id`로 result 조인(보통 불필요).

---

## 4. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| 응답 포맷 | 항상 `{ available, status, message, data }`. 미가용이면 `data=null` |
| 게이트 순서 | 구독(`guild_subscription`) → 계산상태(`mmr_guild_state`) |
| placement | `total_games >= MMR_PLACEMENT_GAMES`(=5). 리더보드는 배치 완료자만 |
| winrate | 저장 안 함 → `total_wins/total_games` 서버 계산(0게임 0%) |
| 표시명 | `riot_account` 조인(puuid→riotName). summary엔 이름 없음 |
| decodeGuildId | GET이라 적용. puuid는 디코딩 안 함 |
| 과거 시즌 | `?season=`으로 조회 허용(데이터는 보관됨). 현재 시즌 기본 |
| is_deleted | soft delete된 유저는 조회에서 제외 |

---

## 5. 완료 기준 (DoD)

- [ ] 비구독 길드: `available=false, status=inactive`
- [ ] 구독+wait_init: `available=false, status=wait_init`
- [ ] 구독+ready: `available=true` + 데이터
- [ ] 개인 MMR: total + 플레이한 포지션별 + `is_placed`(total_games≥5)
- [ ] 리더보드: `is_deleted=false` + 배치 완료자만, total_mmr DESC, 표시명 포함
- [ ] 이력: create_date DESC 페이지네이션
- [ ] winrate 서버 계산(0게임 안전)
- [ ] GET이라 `decodeGuildId` 적용, guildId 디코딩 정상

---

## 6. 의존성 / 다음 step

- **선행**: [step03](./step03_metric_eligible.md)(`isMmrActive`) · [step09](./step09_result_save.md)(저장된 summary/history) · `mmrGuildState`(step07) · `decodeGuildId`/`systemConfigService`
- **후행**: [step11](./step11_admin_api.md)(관리자 조회·운영)
</content>
