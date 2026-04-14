# LoL 내전 대회 시스템 — Phase 3 설계 문서 (v1.1)

> 본 문서는 **Phase 3 (팀 편성)** 에 한정한 설계 문서다.
> v1.0 범위는 **EXCEL 업로드 방식만** 포함한다.
> DRAFT_FLAT / SNAKE_TIERED / AUCTION 은 v2.0으로 분리.

---

## 0. Phase 3 개요

### 0.1 목표
- 엑셀 업로드 기반 팀 편성 (v1.0)
- 3종 엑셀 템플릿 제공: **참가자 대량등록 / 티어 일괄부여 / 팀 편성**
- 팀당 캡틴 1명 필수 제약
- All-or-Nothing 검증 (한 줄이라도 오류면 전체 롤백)
- 수정 시 reset + 재업로드 방식

### 0.2 v1.0 vs v2.0
| 기능 | v1.0 | v2.0 |
|------|------|------|
| EXCEL 업로드 | OK | OK |
| DRAFT_FLAT | X | OK |
| SNAKE_TIERED | X | OK |
| AUCTION | X | OK |
| 실시간 WebSocket 드래프트 | X | OK |

### 0.3 선행 조건
- Phase 1, 2 완료
- 대회 상태 = `CLOSED` (모집 마감)
- SNAKE_TIERED 방식이면 모든 APPROVED 참가자에 `tier` 부여 완료
- `multer`, `xlsx` npm 패키지 설치

---

## 1. 스키마

### 1.1 `tournament_team`
```ts
id                      varchar(21)  PK
tournament_id           varchar(21)  FK NOT NULL
name                    varchar(50)  NOT NULL
captain_participant_id  varchar(21)  FK NOT NULL   // 팀당 캡틴 1명 필수
seed                    int          NOT NULL      // 1~team_count
color                   varchar(20)  NULL
meta                    jsonb        NOT NULL DEFAULT '{}'
created_at, updated_at

UNIQUE (tournament_id, seed);
UNIQUE (tournament_id, captain_participant_id);
```

### 1.2 `tournament_team_member`
```ts
id              varchar(21)  PK
team_id         varchar(21)  FK NOT NULL
participant_id  varchar(21)  FK NOT NULL
role            varchar(10)  NULL       // TOP|JUNGLE|MID|BOT|SUPPORT
pick_order      int          NULL       // v2.0 드래프트/스네이크용
meta            jsonb        NOT NULL DEFAULT '{}'
created_at

UNIQUE (team_id, participant_id);
```

> **제약 요약**
> - 팀당 캡틴 1명 필수 (NOT NULL + UNIQUE)
> - 한 참가자는 한 팀만 (애플리케이션 체크)
> - 팀당 멤버 수 = `tournament.team_size`
> - 역할 **중복 가능** (미드 2명 OK)

---

## 2. 엑셀 템플릿 (3종)

### 2.1 템플릿 A — 참가자 대량등록 (participant_bulk)

**용도**: 외부 모집 참가자 일괄 등록 → 자동 APPROVED + is_proxy_registered=true

**시트**: 단일 시트 `participants`

컬럼: `riot_name | riot_tag | riot_tier | nickname | primary_role | secondary_role | main_champions | playable_time | one_liner | is_captain_candidate`

**처리**
1. xlsx 파싱
2. 각 행 라이엇 계정 매칭 (`account`)
3. **All-or-Nothing**: 한 줄이라도 실패 시 전체 롤백
4. 성공 시 INSERT (`status='APPROVED'`, `is_proxy_registered=true`)

**실패 응답**
```json
{
  "success": false,
  "errors": [
    { "row": 3, "reason": "ACCOUNT_NOT_FOUND", "riotName": "Unknown", "riotTag": "KR1" },
    { "row": 7, "reason": "DUPLICATE", "riotName": "Deft", "riotTag": "KR2" }
  ],
  "totalRows": 22,
  "validRows": 20
}
```

### 2.2 템플릿 B — 티어 일괄부여 (tier_assignment)

**용도**: SNAKE_TIERED 방식일 때 내부 티어(1~N) 부여

**시트**: 단일 시트 `tiers`

컬럼: `participant_id | riot_name | riot_tag | current_tier | new_tier`

**처리**
1. 다운로드 시 현재 APPROVED 참가자 목록 자동 채움
2. 운영자가 `new_tier` 채워서 재업로드
3. All-or-Nothing 검증:
   - `new_tier` ∈ `1 ~ tournament.tier_count`
   - 각 티어별 인원 수가 `team_count` 배수
4. 성공 시 `tournament_participant.tier` 일괄 업데이트

**에러 코드**: `INVALID_TIER_RANGE`, `TIER_COUNT_MISMATCH`

### 2.3 템플릿 C — 팀 편성 (team_composition)

**시트**: 단일 시트 `teams`

컬럼: `team_seed | team_name | team_color | riot_name | riot_tag | role | is_captain`

**검증 (모두 통과해야 INSERT)**
- 모든 행의 `riot_name/riot_tag` APPROVED 참가자 매칭
- 팀 수 = `tournament.team_count`
- 각 팀 멤버 수 = `tournament.team_size`
- 각 팀에 `is_captain=TRUE` **정확히 1명**
- 한 참가자 두 팀 중복 금지
- `team_seed` ∈ `1 ~ team_count`
- 역할 null 허용, **중복 허용**

**에러 코드**
| 코드 | 설명 |
|------|------|
| PARTICIPANT_NOT_APPROVED | 승인되지 않은 참가자 |
| TEAM_COUNT_MISMATCH | 팀 수 불일치 |
| TEAM_SIZE_MISMATCH | 팀당 인원 불일치 |
| CAPTAIN_MISSING | 캡틴 없는 팀 |
| CAPTAIN_DUPLICATE | 한 팀에 캡틴 2명+ |
| PARTICIPANT_IN_MULTIPLE_TEAMS | 중복 배정 |
| INVALID_SEED | team_seed 범위 오류 |

**통과 시**: 기존 팀 데이터 전체 삭제 → 새로 INSERT → `/done` 전환 준비 완료

### 2.4 수정 정책
- 수정 = **reset + 재업로드** (부분 수정 API 없음)
- `DELETE /api/tournaments/:id/teams` 로 초기화

---

## 3. API 목록

| Method | Path | 권한 |
|--------|------|------|
| GET | `/api/tournaments/:id/teams` | public |
| GET | `/api/tournaments/:id/teams/:teamId` | public |
| DELETE | `/api/tournaments/:id/teams` | manager |
| POST | `/api/tournaments/:id/participants/bulk-upload` | manager |
| GET | `/api/tournaments/:id/participants/bulk-template` | manager |
| POST | `/api/tournaments/:id/participants/tier-upload` | manager |
| GET | `/api/tournaments/:id/participants/tier-template` | manager |
| POST | `/api/tournaments/:id/teams/upload` | manager |
| GET | `/api/tournaments/:id/teams/template` | manager |

### 3.1 업로드 공통 스펙
- `Content-Type: multipart/form-data`, 필드명 `file`
- 형식: `.xlsx` (xls 미지원)
- 최대 5MB, multer 메모리 수신 → xlsx 파싱

### 3.2 `POST .../teams/upload` — 응답

**성공**
```json
{
  "success": true,
  "teamsCreated": 4,
  "membersCreated": 20,
  "teams": [
    { "id": "t_abc", "seed": 1, "name": "A팀", "captainParticipantId": "p_xxx", "memberCount": 5 }
  ]
}
```

**실패 (전체 롤백)**
```json
{
  "success": false,
  "errors": [
    { "row": 7, "code": "CAPTAIN_MISSING", "teamSeed": 2 },
    { "row": 15, "code": "PARTICIPANT_NOT_APPROVED", "riotName": "Ghost", "riotTag": "KR1" }
  ]
}
```

---

## 4. 프론트 와이어프레임

### 4.1 팀 편성 페이지 (운영자)
```
┌────────────────────────────────────────────┐
│ 4월 정기 내전 — 팀 편성                     │
├────────────────────────────────────────────┤
│ 편성 방식: EXCEL                            │
│                                            │
│ Step 1. [팀 편성 템플릿 다운로드 (xlsx)]    │
│ Step 2. 템플릿에 팀 구성 입력               │
│ Step 3. [파일 선택] [업로드]                │
│                                            │
│ 현재 편성: 4팀 / 20명 편성 완료             │
│ [편성 초기화] [대회 완료(/done)로 전환]     │
└────────────────────────────────────────────┘
```

### 4.2 팀 탭 (공개 조회)
```
팀 (4)
┌─ A팀 (blue) ────────────────────────┐
│ ★ 페이커 (MID)  ← 캡틴              │
│   Zeus (TOP) / Oner (JUNGLE)         │
│   Deft (BOT) / Keria (SUPPORT)       │
└─────────────────────────────────────┘
┌─ B팀 (red) ─────────────────────────┐
│ ★ 쵸비 (MID)  ← 캡틴                │
│   ...                                │
└─────────────────────────────────────┘
```

---

## 5. Validation 원칙 (Phase별)

| Phase | 정책 | 이유 |
|-------|------|------|
| Phase 2 웹 신청 | 즉시 실패 반환 | 한 명씩 제출 |
| Phase 3 bulk-upload | All-or-Nothing | 일관성 |
| Phase 3 tier-upload | All-or-Nothing | 티어 밸런스 |
| Phase 3 teams/upload | All-or-Nothing | 팀 제약 강함 |

> 부분 성공은 v1.0에서 전면 금지.

---

## 6. 테스트 체크리스트 (Phase 3)

### 6.1 참가자 대량등록
- [ ] 정상 업로드 → 전원 APPROVED + is_proxy_registered=true
- [ ] 계정 매칭 실패 1건 → 전체 롤백
- [ ] 중복 행 → 롤백
- [ ] 대회 OPEN 상태에서만 허용

### 6.2 티어 일괄부여
- [ ] 템플릿 다운로드 시 APPROVED 목록 자동 채움
- [ ] new_tier 범위 초과 → 롤백
- [ ] 티어별 인원 불균형 → 롤백
- [ ] SNAKE_TIERED 아닌 대회에서 업로드 차단 (409)

### 6.3 팀 편성 업로드
- [ ] 정상 편성 → INSERT
- [ ] 캡틴 없는 팀 → 롤백
- [ ] 캡틴 2명 → 롤백
- [ ] 승인되지 않은 참가자 → 롤백
- [ ] 한 참가자 두 팀 배정 → 롤백
- [ ] 팀 수/인원 불일치 → 롤백
- [ ] 역할 중복 허용 (미드 2명 OK)
- [ ] reset 후 재업로드 성공

### 6.4 상태 전이
- [ ] 편성 완료 후 `/done` 성공
- [ ] 편성 없이 `/done` 차단 (409)
- [ ] DONE 상태에서 팀 편성 API 차단

---

## 7. 보류 사항 (v2.0)

- 팀 편성 히스토리(audit log) 보류
- 팀 편성 시뮬레이션(dry-run) 모드 보류
- 엑셀 컬럼 포맷은 v2.0에서도 **하위 호환 유지**

---

## 8. 다음 단계

v1.0 Phase 1~3 완료 시:
1. 프론트 데모 페이지 구축 (목록/신청폼/팀 편성)
2. 실제 길드에서 소규모 테스트 운영
3. 피드백 → v2.0 (DRAFT_FLAT, SNAKE_TIERED, AUCTION) 착수

---

**문서 버전**: v1.1
**최종 수정**: 2026-04-14
**대상 Phase**: 3 (팀 편성 — EXCEL 전용)
