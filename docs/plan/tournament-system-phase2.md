# LoL 내전 대회 시스템 — Phase 2 설계 문서 (v1.1)

> 본 문서는 **Phase 2 (참가 신청/승인)** 에 한정한 설계 문서다.
> Phase 1 (대회 생성) 완료 후 착수하며, Phase 3 (팀 편성)의 선행 조건이다.

---

## 0. Phase 2 개요

### 0.1 목표
- 대회에 대한 **참가 신청** 기능 (웹 본인 신청 + 엑셀 대리등록)
- **Source-differentiated Approval** — 소스에 따라 승인 기본값 차등
- 운영자의 승인/거절 워크플로우
- 참가자 상세 정보 수집 (라이엇 계정, 티어, 라인, 메인챔프, 한마디 등)
- 재신청(re-apply) 허용

### 0.2 선행 조건
- [x] Phase 1 완료 (`tournament` 테이블, `requireGuildManager` 미들웨어)
- [ ] `account` 테이블 구조 확인 (PK 타입, 라이엇 계정 매칭 방법)
- [ ] `guild_member` 테이블에 로그인 유저가 등록되어 있어야 함

---

## 1. 핵심 설계 결정

### 1.1 계정 모델 (중요)
사용자 설명에 따르면:
> **"웹에 로그인을 하고 본인 길드에 입장하려면 내전을 한판이라도 해야 하는 사람이라, 없는 계정은 없다."**

- 모든 참가자는 이미 `account` 테이블에 존재함
- `tournament_participant.account_id` 는 **NOT NULL**
- 잘못 입력된 라이엇 계정명은 "매칭 실패" 알림만 주고 본인이 수정

### 1.2 Source-differentiated Approval
| 등록 경로 | 초기 status | 설명 |
|----------|------------|------|
| 웹 본인 신청 | `APPLIED` | 운영자 승인 대기 |
| 엑셀 대리등록 (Phase 3의 participant_bulk 템플릿) | `APPROVED` | 운영자가 직접 올린 것이므로 자동 승인 |
| `is_proxy_registered` | `true` (대리등록) / `false` (본인) | 감사(audit) 용도 |

### 1.3 티어 포맷
- **브론즈/실버/골드/플래티넘/에메랄드/다이아**: 영문 대문자 + 숫자 (`B4`, `D2`)
- **마스터**: `M` + LP (`M482`, `M0`)
- **그랜드마스터**: `GM` + LP (`GM1300`)
- **챌린저**: `C` + LP (`C1400`)
> 저장은 자유 텍스트(`varchar(10)`). 정규식 validation 없이 안내 문구만 제공.

### 1.4 is_captain_candidate (팀장 의사)
- `true` = "팀장을 **하고 싶다**" (의사 표현)
- 실제 캡틴 여부는 Phase 3의 `tournament_team.captain_participant_id` 로 결정

### 1.5 메인 챔피언 (오타 허용)
- 자유 텍스트 배열 (`jsonb`), 예: `["카직스","리신","오리"]`
- 챔피언 마스터 테이블 매칭 안 함 (오타/축약어 허용)

---

## 2. 스키마

### 2.1 `tournament_participant`
```ts
id                    varchar(21)  PK
tournament_id         varchar(21)  FK NOT NULL
account_id            <account PK> FK NOT NULL
riot_name             varchar      NOT NULL
riot_tag              varchar      NOT NULL
riot_tier             varchar(10)  NULL
discord_user_id       varchar      NULL
nickname              varchar      NULL
playable_time         varchar(100) NULL
primary_role          varchar(10)  NULL       // TOP|JUNGLE|MID|BOT|SUPPORT
secondary_role        varchar(10)  NULL
main_champions        jsonb        NOT NULL DEFAULT '[]'
one_liner             varchar(200) NULL
is_captain_candidate  boolean      NOT NULL DEFAULT false
tier                  int          NULL       // SNAKE_TIERED용 내부 티어(1~N)
status                varchar(20)  NOT NULL   // APPLIED|APPROVED|REJECTED|WITHDRAWN
is_proxy_registered   boolean      NOT NULL DEFAULT false
note                  text         NULL
meta                  jsonb        NOT NULL DEFAULT '{}'
created_at, updated_at

CREATE UNIQUE INDEX idx_participant_unique_active
  ON tournament_participant (tournament_id, account_id)
  WHERE status != 'WITHDRAWN';

CREATE INDEX idx_participant_tournament_status
  ON tournament_participant (tournament_id, status);
```

### 2.2 상태 머신
```
  APPLIED ──승인──▶ APPROVED
     │                │
     거절             철회
     ▼                ▼
  REJECTED        WITHDRAWN  ← 재신청 가능(새 레코드)
```

| 전이 | 주체 | 조건 |
|------|------|------|
| `→ APPLIED` | 본인 웹 신청 | 대회 `OPEN` |
| `→ APPROVED` | 운영자 승인 or 엑셀 대리등록 | `OPEN`/`CLOSED` 둘 다 |
| `→ REJECTED` | 운영자 | `note` 에 사유 기록 |
| `→ WITHDRAWN` | 본인/운영자 | `APPLIED`/`APPROVED` 에서 |

### 2.3 재신청 규칙
- `WITHDRAWN` 이후 동일 account 새 레코드로 재신청 가능
- 부분 UNIQUE 인덱스가 `status != 'WITHDRAWN'` 조건이므로 중복 허용

---

## 3. API 목록

| Method | Path | 권한 |
|--------|------|------|
| POST | `/api/tournaments/:id/participants` | 로그인 유저 |
| GET | `/api/tournaments/:id/participants?status=` | public |
| GET | `/api/tournaments/:id/participants/:pid` | public |
| PATCH | `/api/tournaments/:id/participants/:pid` | 본인/manager |
| POST | `/api/tournaments/:id/participants/:pid/approve` | manager |
| POST | `/api/tournaments/:id/participants/:pid/reject` | manager |
| POST | `/api/tournaments/:id/participants/:pid/withdraw` | 본인/manager |
| GET | `/api/tournaments/:id/participants/me` | 로그인 유저 |

### 3.1 `POST .../participants` 요청
```json
{
  "riotName": "Hide on bush",
  "riotTag": "KR1",
  "riotTier": "C1400",
  "playableTime": "평일 밤 9시 이후, 주말 종일",
  "primaryRole": "MID",
  "secondaryRole": "TOP",
  "mainChampions": ["아리","제드","아칼리"],
  "oneLiner": "캐리합니다",
  "isCaptainCandidate": true
}
```

**처리**
1. 대회 `OPEN` 확인 → 아니면 `409 INVALID_STATE`
2. 세션에서 `account_id` 획득
3. `riot_name#riot_tag` 로 `account` 매칭 → 실패 시 `400 ACCOUNT_NOT_FOUND`
4. 중복 체크 → `409 ALREADY_APPLIED`
5. INSERT (`status='APPLIED'`, `is_proxy_registered=false`)

### 3.2 `GET .../participants` 응답
```json
{
  "items": [ { "id":"p_abc", "riotName":"...", "status":"APPROVED", ... } ],
  "summary": {
    "applied": 3, "approved": 17, "rejected": 1,
    "withdrawn": 2, "captainCandidates": 5
  }
}
```

### 3.3 `PATCH .../participants/:pid`
- 본인: `OPEN` 동안 자기 신청서 수정 (라이엇/역할/챔프/한마디/playableTime/isCaptainCandidate)
- manager 전용: `tier`, `note`, `nickname`, `status`

### 3.4 `approve` / `reject`
- 대상 상태 `APPLIED` 여야 함 (아니면 `409 INVALID_STATE`)
- `reject` 는 `note` 에 `{ "reason": "..." }` 기록

### 3.5 `withdraw`
- `APPLIED` / `APPROVED` 에서만 가능

---

## 4. Validation 규칙

| 필드 | 규칙 |
|------|------|
| riotName | 1~32자 |
| riotTag | 2~5자 영숫자 |
| riotTier | 형식 권장(경고만, 차단 X) |
| primaryRole/secondaryRole | `TOP\|JUNGLE\|MID\|BOT\|SUPPORT` or null |
| mainChampions | 배열 최대 10개, 각 1~20자 |
| oneLiner | 최대 200자 |
| playableTime | 최대 100자 |

> **역할 중복 허용**: `primaryRole === secondaryRole` 허용

---

## 5. 프론트 와이어프레임

### 5.1 참가 신청 폼
```
┌──────────────────────────────────────┐
│ 4월 정기 내전 — 참가 신청            │
├──────────────────────────────────────┤
│ 라이엇:  [Hide on bush ]             │
│ 태그:    [#KR1 ]                     │
│ 티어:    [C1400]  [?티어 안내]       │
│ 주/부:   [MID▼] [TOP▼]               │
│ 메인챔프:[아리, 제드, 아칼리      ]  │
│ 시간:    [평일 밤 9시 이후        ]  │
│ 한마디:  [캐리합니다              ]  │
│ □ 팀장 하고 싶어요                   │
│             [취소] [신청하기]        │
└──────────────────────────────────────┘
```

### 5.2 참가자 목록 (운영자 탭)
```
참가자 (22) ▸ 대기 3 / 승인 17 / 거절 1 / 철회 2
★ | 닉네임 | 라이엇         | 티어  | 주/부   | 상태
★ | 페이커 | Hide on bush#KR1| C1400| MID/TOP | 대기[승인][거절]
  | 쵸비   | Deft#KR2       | M482 | MID/BOT | 승인
★ | 케리아 | Keria#KR1      |GM1300| SUP/MID | 승인

★ = is_captain_candidate
```

---

## 6. 테스트 체크리스트 (Phase 2)

- [ ] 본인 신청 성공 (OPEN)
- [ ] 본인 신청 실패 — CLOSED/DONE (409)
- [ ] 본인 신청 실패 — 계정 매칭 실패 (400)
- [ ] 본인 신청 실패 — 이미 활성 신청 (409)
- [ ] 재신청 성공 (과거 WITHDRAWN 이후)
- [ ] 본인 수정 성공 / 남의 신청서 수정 차단 (403)
- [ ] 승인 성공 (APPLIED → APPROVED)
- [ ] 승인 실패 — 이미 APPROVED (409)
- [ ] 거절 성공 (note 기록)
- [ ] 본인 철회 / 운영자 강제 철회
- [ ] 목록 status 필터 & summary 집계
- [ ] 비로그인 목록 조회 허용 (200)
- [ ] 역할 중복 입력 허용 (primary===secondary)

---

## 7. 다음 Phase 연결 지점

Phase 3 진입 전:
1. `APPROVED` 참가자 수 ≥ `team_size × team_count`
2. SNAKE_TIERED일 때 모든 APPROVED 참가자에 `tier` 부여 완료
3. `is_captain_candidate=true` 수 ≥ `team_count` 권장 (필수 아님)

---

**문서 버전**: v1.1
**최종 수정**: 2026-04-14
**대상 Phase**: 2 (참가 신청/승인)
