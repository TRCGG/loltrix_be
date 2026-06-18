# step06 — gmok_mmr 클라이언트

> 상위 문서: [03_api_contract.md](../03_api_contract.md) (전체) | [01_architecture §4, §5](../01_architecture.md)
> 선행: [step02_schema.md](./step02_schema.md) | 다음: [step07_subscription.md](./step07_subscription.md)

---

## 1. 목적 / 범위

gmok_mmr HTTP 엔드포인트 2개를 호출하는 **클라이언트**를 만든다. 요청 조립·응답 파싱·**에러 분류(재시도 가능/불가)** 까지가 책임이다. DB 접근·상태 변경은 하지 않는다(호출자=step08/09/11).

> **axios 안 씀.** 레포 컨벤션은 native `fetch` + [`src/utils/fetchWithTimeout.ts`](src/utils/fetchWithTimeout.ts)(AbortController 기반). 이를 따른다.

### 엔드포인트 ([03 §1](../03_api_contract.md))

| 메서드 | 경로 | 클라이언트 메서드 | 타임아웃 |
|---|---|---|---|
| POST | `/v1/mmr/baselines/calculate` | `calculateBaseline` | 길다 (`MMR_BASELINE_TIMEOUT_MS`, 기본 60000) |
| POST | `/v1/mmr/matches/calculate` | `calculateMatch` | 짧다 (`MMR_MATCH_TIMEOUT_MS`, 기본 5000) |
| GET | `/health` | `health` (선택) | 2000 |

### 산출물

| 파일 | 변경 |
|---|---|
| `src/types/mmr.ts` | 신규 — 요청/응답/에러 타입 (03 계약과 1:1) |
| `src/services/mmrClient.service.ts` | 신규 — `calculateBaseline` / `calculateMatch` / `health` |
| config (env) | `MMR_SERVICE_URL`, `MMR_MATCH_TIMEOUT_MS`, `MMR_BASELINE_TIMEOUT_MS` |

---

## 2. 타입 (`src/types/mmr.ts`)

[03 §3~5](../03_api_contract.md)와 1:1. 핵심만:

```ts
// 공통 player-game row (03 §3) — mmr_participant_metric에서 변환(리네임 + match_participant_id join)된 전송 포맷. 1:1 아님
export interface PlayerGameRow {
  custom_match_id: string; match_participant_id: number; guild_id: string; season: string;
  puuid: string; champion_id: string; game_team: 'blue' | 'red'; position: 'TOP'|'JUG'|'MID'|'ADC'|'SUP';
  game_result: 0 | 1; played_date: string;             // ISO
  time_played: number; kill: number; death: number; assist: number; gold: number; ccing: number; exp: number;
  total_damage_champions: number; total_damage_taken: number; vision_score: number;
  total_damage_dealt_to_buildings: number; vision_bought: number; minions_killed: number;
  neutral_minions_killed: number; wards_placed: number; wards_killed: number;
  time_spent_dead: number; heal_on_teammates: number; shield_on_teammates: number;
}

// API 1 — baseline (03 §4)
export interface BaselineCalcRequest { season: string; baseline_version: string; min_match_count: number; matches: PlayerGameRow[]; }
export interface BaselineCalcResponse {
  season: string; baseline_version: string;
  mmr_baseline: Record<string, number>;            // { f1_mean, f2_mean }
  game_impact_baseline: Record<string, unknown>;   // { position_weights, outcome_stats }
  metadata: { match_count: number; player_game_row_count: number; calculated_at: string };
}

// API 2 — 단일 경기 (03 §5)
export interface PreMatchUserSummary { puuid: string; positions: { position: string; pos_mmr: number; pos_games: number; pos_wins: number }[]; }
export interface MatchCalcRequest {
  guild_id: string; season: string; calculation_id: string; custom_match_id: string; baseline_version: string;
  mmr_baseline: Record<string, number>; game_impact_baseline: Record<string, unknown>;
  match_rows: PlayerGameRow[];                       // 정확히 10
  pre_match_user_summary: PreMatchUserSummary[];
}
export interface MatchCalcResponse {
  guild_id: string; season: string; calculation_id: string; custom_match_id: string; baseline_version: string;
  match_results: MatchResultRow[]; updated_user_summary: UpdatedUserSummary[]; mmr_history: MmrHistoryRow[];
  metadata: { calculated_at: string };
}
// match_results / updated_user_summary / mmr_history 의 항목 타입은 03 §5.2 그대로.

// 에러 바디 (03 §4.3, §5.3)
export interface MmrErrorBody { error_code: string; message: string; details?: Record<string, unknown>; }
```

---

## 3. 에러 분류 — 재시도 가능 여부 ([03 §9](../03_api_contract.md))

클라이언트는 HTTP 결과를 **두 부류**로 나눠 던진다. 호출자(worker/handler)는 이걸로 분기한다.

| 상황 | 클라이언트가 던지는 것 | 호출자(step08/09/11) 동작 |
|---|---|---|
| HTTP 400 (검증 실패) | `MmrContractError(retryable=false, errorCode, details)` | 해당 경기 `mmr_match_queue=fail`, **재시도 안 함** |
| HTTP 422 `INSUFFICIENT_DATA` | `MmrContractError(retryable=false, errorCode='INSUFFICIENT_DATA')` | baseline 실패 → `mmr_guild_state=error` (step11/12) |
| HTTP 5xx | `MmrServiceError`(=SystemError, retryable) | job markFail → 다음 tick 재시도(max 3) |
| timeout / 네트워크 / gmok 다운 | `MmrServiceError` | 동상. 다운이면 tick 전체가 같은 사유로 skip |

```ts
// 재시도 불가: 계약/검증 실패 (400/422)
export class MmrContractError extends Error {
  constructor(public httpStatus: number, public errorCode: string, message: string, public details?: Record<string, unknown>) {
    super(message); this.name = 'MmrContractError'; Object.setPrototypeOf(this, MmrContractError.prototype);
  }
}
// 재시도 가능: 일시 장애 (5xx/timeout/network) — SystemError 계열로 worker가 자동 재시도
export class MmrServiceError extends SystemError {}
```

> **핵심 구분**: `MmrContractError`(결정적 실패 → 재시도 무의미)와 `MmrServiceError`(일시 장애 → 재시도). step09 핸들러는 전자를 잡으면 경기를 `fail`로 확정하고 **잡은 더 재시도하지 않게** 처리한다(자세히는 step09).

---

## 4. 클라이언트 (`src/services/mmrClient.service.ts`)

```ts
const BASE_URL = process.env.MMR_SERVICE_URL ?? 'http://localhost:8000';
const MATCH_TIMEOUT = Number(process.env.MMR_MATCH_TIMEOUT_MS ?? 5000);
const BASELINE_TIMEOUT = Number(process.env.MMR_BASELINE_TIMEOUT_MS ?? 60000);

class MmrClient {
  async calculateMatch(req: MatchCalcRequest): Promise<MatchCalcResponse> {
    return this.postJson('/v1/mmr/matches/calculate', req, MATCH_TIMEOUT);
  }
  async calculateBaseline(req: BaselineCalcRequest): Promise<BaselineCalcResponse> {
    return this.postJson('/v1/mmr/baselines/calculate', req, BASELINE_TIMEOUT);
  }
  async health(): Promise<boolean> {
    try { const r = await fetchWithTimeout(`${BASE_URL}/health`, { method: 'GET' }, 2000); return r.ok; }
    catch { return false; }
  }

  private async postJson<T>(path: string, body: unknown, timeout: number): Promise<T> {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${BASE_URL}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }, timeout);
    } catch (e) {
      // fetchWithTimeout: AbortError → SystemError(504). 그 외 network 오류도 일시 장애로.
      throw new MmrServiceError(`gmok_mmr request failed: ${path}`, 503);
    }

    if (res.ok) return (await res.json()) as T;

    // 에러 바디 파싱 (실패해도 진행)
    let errBody: MmrErrorBody | undefined;
    try { errBody = (await res.json()) as MmrErrorBody; } catch { /* noop */ }

    if (res.status === 400 || res.status === 422) {
      throw new MmrContractError(res.status, errBody?.error_code ?? 'UNKNOWN', errBody?.message ?? res.statusText, errBody?.details);
    }
    // 5xx 등 → 재시도 대상
    throw new MmrServiceError(`gmok_mmr ${res.status} on ${path}: ${errBody?.message ?? res.statusText}`, 502);
  }
}
export const mmrClient = new MmrClient();
```

---

## 5. 결정사항 / 주의점

| 항목 | 내용 |
|---|---|
| HTTP 스택 | native fetch + `fetchWithTimeout`. **axios 도입 안 함**(레포 무의존) |
| 타임아웃 분리 | match 짧게(5s), baseline 길게(60s). 산식 NFR([01 §5](../01_architecture.md))에 맞춤 |
| 인증 | **없음**(내부망, [기획 §6.12](../00_overview.md)). 헤더는 `Content-Type`만 |
| 에러 2분류 | `MmrContractError`(400/422, 재시도X) vs `MmrServiceError`(5xx/timeout, 재시도O) |
| 필드 케이스 | wire는 **snake_case**(03 계약). camelCase 변환은 호출자(step08/09)가 조립/해석 시 처리 |
| `calculation_id` | 클라이언트가 만들지 않음. 호출자가 nanoid로 생성해 req에 넣음([03 §10](../03_api_contract.md)) |
| 멱등 baseline | RECALC마다 baseline 재학습 ❌. 저장된 baseline을 매 match 요청에 그대로 실음([03 §7.3](../03_api_contract.md)) — 이 조립은 step08 |
| DB 접근 | 없음. 순수 HTTP |

---

## 6. 완료 기준 (DoD)

- [ ] `calculateMatch`/`calculateBaseline`이 정상 응답을 타입대로 파싱 반환
- [ ] HTTP 400/422 → `MmrContractError`(errorCode·details 보존) throw
- [ ] HTTP 5xx → `MmrServiceError` throw
- [ ] timeout(AbortError)·network 오류 → `MmrServiceError` throw (재시도 대상)
- [ ] `health()`가 다운 시 false 반환(throw 안 함)
- [ ] DB·상태 변경 코드 없음 (순수 클라이언트)
- [ ] `MMR_SERVICE_URL` 미설정 시 기본값으로 동작

---

## 7. 의존성 / 다음 step

- **선행**: 없음(독립). 타입은 [step02](./step02_schema.md) 스키마와 의미상 정합
- **후행**: [step08](./step08_incremental_worker.md)(`calculateMatch` 호출+payload 조립) · [step09](./step09_result_save.md)(응답 저장·에러 분기) · [step11](./step11_admin_api.md)(`calculateBaseline` 호출)
</content>
