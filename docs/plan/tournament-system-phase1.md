# LoL 내전 대회 시스템 — Phase 1 설계 문서 (v1.1)

> 본 문서는 **Phase 1 (대회 생성/관리 기반)** 에 한정한 설계 문서다.
> Phase 2 (참가신청) / Phase 3 (팀 편성) 은 별도 문서로 분리한다.
> 다른 대화창에서도 이 문서를 참조하여 구현을 이어갈 수 있도록 작성되었다.

---

## 0. 프로젝트 개요

### 0.1 목적
LoL 클랜 내전(scrim) 대회를 **웹**에서 생성하고, 참가자 신청을 받고, 팀을 편성하여 그 결과를 저장·표시한다.

### 0.2 범위

| 구분 | 내용 |
|------|------|
| **IN**  | 대회 생성/수정/삭제, 참가자 모집(웹 신청 + 엑셀 대리등록), 팀 편성(4가지 방식), 대회 데이터 저장, 대회 데이터 조회 |
| **OUT** | 브라켓/대진 생성, 경기 결과 입력, 승/패 집계, MVP 선정 — **각 클랜이 알아서 운영** |
| **플랫폼** | 웹 전용 (Discord bot 연동 X) |
| **작업 순서** | 백엔드 선행 → 프론트 데모 점진 |

### 0.3 개발 브랜치
- `trcgg/loltrix_be`   : `claude/add-plan-recommendations-ZnuZ0`
- `trcgg/trcgg_front`  : `claude/add-plan-recommendations-ZnuZ0`
- `trcgg/trcgg_bot`    : 본 프로젝트 제외

### 0.4 기술 스택
- **Backend**  : TypeScript, Express, Drizzle ORM, PostgreSQL, Zod, nanoid, passport-discord, multer, xlsx
- **Frontend** : Next.js 12, React 18, TailwindCSS, React Query

---

## 1. 용어 정리

| 용어 | 설명 |
|------|------|
| **Guild** | 디스코드 클랜 단위. 각 길드는 동시에 **1개의 활성 대회**만 가질 수 있다. |
| **Tournament** | 내전 대회. `OPEN → CLOSED → DONE` 3-state FSM. |
| **Participant** | 대회 참가자. `APPLIED / APPROVED / REJECTED / WITHDRAWN` 상태. |
| **Team** | 팀 편성 단위. 팀당 **캡틴 1명 필수**. |
| **Team Member** | 팀에 소속된 참가자. 팀당 `team_size` 명. |
| **Composition Method** | 팀 편성 방식. `EXCEL / DRAFT_FLAT / SNAKE_TIERED / AUCTION` 4종. (v1.0에서는 **EXCEL만** 구현) |
| **Source-differentiated Approval** | 웹 본인 신청 → `APPLIED`, 엑셀 대리 등록 → 자동 `APPROVED`. |
| **guild_manager** | 길드 관리자. 대회 CRUD/승인 권한 보유. |

---

## 2. 전체 플로우 (End-to-End)

```
[운영자]                                   [참가자]
  │                                          │
  ├─ 1. 대회 생성 (OPEN) ────────────────────▶│
  │                                          │
  │                                          ├─ 2. 웹에서 참가 신청 (APPLIED)
  │                                          │
  ├─ 3. 승인/거절 (APPROVED/REJECTED)        │
  ├─    or 엑셀 대리등록 (→ 자동 APPROVED)   │
  │                                          │
  ├─ 4. /close (CLOSED) ─ 모집 마감          │
  │                                          │
  ├─ 5. (SNAKE일 때만) 티어 일괄 부여        │
  │                                          │
  ├─ 6. 팀 편성 (EXCEL 업로드)               │
  │                                          │
  ├─ 7. /done (DONE) ── 대회 종료            │
  │                                          │
  └─ 8. 결과 조회 / 엑셀 다운로드            │
```

> **Phase 1은 위 플로우 중 1, 4, 7, 8 (대회 CRUD + 상태 전이 + 조회)에 해당한다.**

---

## 3. Phase 1 — 대회 생성/관리 기반

### 3.1 목표
- 대회 CRUD 완성
- 상태 머신 (OPEN/CLOSED/DONE) 정착
- **한 길드당 활성 대회 1개** 제약 (부분 UNIQUE 인덱스)
- 목록/상세 조회 API 완비
- 권한 (guild_manager) 체크
- 테스트 대회(`is_test`) / 소프트 딜리트(`is_deleted`) 지원

### 3.2 스키마

#### `tournament`
```ts
id                     varchar(21)  PK              // nanoid
guild_id               varchar      NOT NULL
name                   varchar(100) NOT NULL
description            text         NULL
composition_method     varchar(20)  NOT NULL        // EXCEL | DRAFT_FLAT | SNAKE_TIERED | AUCTION
team_size              int          NOT NULL        // 팀당 인원 (보통 5)
team_count             int          NOT NULL        // 팀 수
tier_count             int          NULL            // SNAKE_TIERED일 때만 사용 (예: 5)
status                 varchar(20)  NOT NULL        // OPEN | CLOSED | DONE
start_at               timestamptz  NULL
recruit_deadline       timestamptz  NULL
is_test                boolean      NOT NULL DEFAULT false
is_deleted             boolean      NOT NULL DEFAULT false
created_by_discord_id  varchar      NOT NULL
created_by_nickname    varchar      NULL
meta                   jsonb        NOT NULL DEFAULT '{}'
created_at             timestamptz  NOT NULL DEFAULT now()
updated_at             timestamptz  NOT NULL DEFAULT now()

-- 한 길드에 동시 활성 대회 1개만
CREATE UNIQUE INDEX idx_tournament_guild_active
  ON tournament (guild_id)
  WHERE status IN ('OPEN','CLOSED') AND is_deleted = false AND is_test = false;

CREATE INDEX idx_tournament_guild_created
  ON tournament (guild_id, created_at DESC)
  WHERE is_deleted = false;
```

> **주의**: `is_test = true` 인 대회는 활성 제약에서 제외된다. 테스트 대회는 여러 개를 동시에 만들 수 있다.

### 3.3 상태 머신 (FSM)

```
  ┌───────┐  /close   ┌────────┐  /done   ┌──────┐
  │ OPEN  │ ────────▶ │ CLOSED │ ───────▶ │ DONE │
  └───────┘           └────────┘          └──────┘
      │                    │                  │
      └─ DELETE (soft) ◀───┴──────────────────┘
```

| 전이 | 조건 |
|------|------|
| `OPEN → CLOSED`  | 운영자가 `/close` 호출. 모집 마감. 참가자 신청 불가. |
| `CLOSED → DONE`  | 팀 편성 완료 후 운영자가 `/done` 호출. |
| `* → deleted`    | `is_deleted = true` (soft delete). 목록에서 제외. |

- **역전이 없음** (일방향). 되돌릴 일 있으면 새 대회 생성.
- `DONE` 이후 수정 불가 (참가자/팀 포함 전체 잠금).

### 3.4 권한 모델

| Role | 권한 |
|------|------|
| **비로그인** | 목록/상세 조회만 (공개) |
| **일반 멤버** | 목록/상세 조회 + 자기 길드 대회에 참가신청 (Phase 2) |
| **guild_manager** | 자기 길드 대회 CRUD + 승인/거절 + 상태 전이 + 팀 편성 |
| **superadmin** | 전 길드 모든 권한 (테스트/장애대응용) |

- 권한 체크 방식: **옵션 C** — 기존 `guild_member.role` 컬럼 활용 (`manager` / `member`).
- 미들웨어: `requireGuildManager(guildId)` — req.user의 해당 길드 role 조회해서 체크.

### 3.5 API 목록

| Method | Path | 설명 | 권한 |
|--------|------|------|------|
| `POST`   | `/api/tournaments`                          | 대회 생성 | manager |
| `GET`    | `/api/tournaments?guildId=&status=&page=`   | 대회 목록 (최신순, offset 기반) | public |
| `GET`    | `/api/tournaments/:id`                      | 대회 상세 | public |
| `PATCH`  | `/api/tournaments/:id`                      | 대회 수정 (OPEN 상태에서만) | manager |
| `DELETE` | `/api/tournaments/:id`                      | 소프트 딜리트 | manager |
| `POST`   | `/api/tournaments/:id/close`                | OPEN → CLOSED | manager |
| `POST`   | `/api/tournaments/:id/done`                 | CLOSED → DONE | manager |

#### 3.5.1 `POST /api/tournaments` — 요청 바디
```json
{
  "guildId": "123456789",
  "name": "4월 정기 내전",
  "description": "월례 내전입니다",
  "compositionMethod": "EXCEL",
  "teamSize": 5,
  "teamCount": 4,
  "tierCount": null,
  "startAt": "2026-04-20T19:00:00+09:00",
  "recruitDeadline": "2026-04-19T23:59:59+09:00",
  "isTest": false
}
```

**Validation (Zod)**
- `compositionMethod` ∈ `{EXCEL, DRAFT_FLAT, SNAKE_TIERED, AUCTION}`
- `SNAKE_TIERED` 이면 `tierCount` 필수 (2~10)
- 그 외 방식이면 `tierCount` 는 null 또는 무시
- `teamSize` ∈ `[1, 10]`, `teamCount` ∈ `[2, 20]`
- `recruitDeadline < startAt` (있다면)
- `name` : 1~100자, 공백 trim

**에러 케이스**
- `409 CONFLICT`: 같은 길드에 이미 활성 대회가 있음 (`ACTIVE_TOURNAMENT_EXISTS`)
- `403 FORBIDDEN`: 해당 길드 manager 아님
- `400 BAD_REQUEST`: validation 실패

#### 3.5.2 `GET /api/tournaments` — 쿼리
```
?guildId=xxx&status=OPEN|CLOSED|DONE&includeDeleted=false&page=1&pageSize=20
```
- 정렬: `created_at DESC`
- 페이징: offset 기반 (`page`, `pageSize`)
- 기본값: `page=1, pageSize=20, includeDeleted=false, isTest` 포함

**응답**
```json
{
  "items": [
    {
      "id": "abc123",
      "name": "4월 정기 내전",
      "status": "OPEN",
      "compositionMethod": "EXCEL",
      "teamSize": 5,
      "teamCount": 4,
      "participantCount": 12,
      "startAt": "2026-04-20T10:00:00Z",
      "createdByNickname": "홍길동",
      "isTest": false,
      "createdAt": "2026-04-14T05:00:00Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "totalCount": 37
}
```

#### 3.5.3 `GET /api/tournaments/:id`
- 대회 기본 정보 + 참가자 수 + 팀 구성 진행도(요약)
- Phase 2, 3 데이터는 해당 Phase API에서 별도 로드

#### 3.5.4 `POST /api/tournaments/:id/close`
- 상태 체크: 현재 `OPEN` 이어야 함
- 실행: `status = 'CLOSED'`, `updated_at` 갱신
- 에러: `409 INVALID_STATE` (이미 CLOSED/DONE), `403`

#### 3.5.5 `POST /api/tournaments/:id/done`
- 상태 체크: 현재 `CLOSED` 이어야 함
- **사전 조건**: 팀 편성이 완료되어 있어야 함 (Phase 3에서 체크) — Phase 1에서는 상태만 허용
- 실행: `status = 'DONE'`

#### 3.5.6 `DELETE /api/tournaments/:id`
- Soft delete: `is_deleted = true`
- 연관 데이터(participant, team) 는 그대로 두되 조회 시 필터링

### 3.6 파일 구조 (Backend)

```
src/
├─ routes/
│   └─ tournament.route.ts
├─ controllers/
│   └─ tournament.controller.ts
├─ services/
│   └─ tournament.service.ts
├─ database/
│   ├─ schema/
│   │   └─ tournament.schema.ts      # Drizzle 테이블 정의
│   └─ repositories/
│       └─ tournament.repository.ts  # DB 접근
├─ facade/
│   └─ tournament.facade.ts          # 복합 유스케이스 (선택)
├─ middlewares/
│   └─ requireGuildManager.ts
├─ types/
│   └─ tournament.types.ts           # DTO, Zod schemas
└─ utils/
    └─ nanoid.ts
```

### 3.7 Validation 원칙
- Zod 스키마를 `types/tournament.types.ts` 에 모아둠
- controller 진입 시 `schema.parse(req.body)` 로 **전량 검증 후 처리**
- DB 레벨 제약(UNIQUE, NOT NULL)은 **2차 방어선**으로만 신뢰

### 3.8 테스트 체크리스트 (Phase 1)

- [ ] 대회 생성 성공 (EXCEL 방식)
- [ ] 대회 생성 실패 — 같은 길드 활성 대회 존재 (409)
- [ ] 대회 생성 성공 — `isTest=true` 이면 활성 대회 있어도 생성 가능
- [ ] 대회 생성 실패 — `SNAKE_TIERED` 인데 `tierCount` 없음 (400)
- [ ] 대회 수정 성공 (OPEN 상태)
- [ ] 대회 수정 실패 — CLOSED/DONE 상태 (409)
- [ ] `/close` 성공 (OPEN → CLOSED)
- [ ] `/close` 실패 — 이미 CLOSED (409)
- [ ] `/done` 성공 (CLOSED → DONE)
- [ ] `/done` 실패 — 아직 OPEN (409)
- [ ] Soft delete 후 목록에서 제외
- [ ] `includeDeleted=true` 로 삭제된 대회 조회
- [ ] manager가 아닌 유저의 CRUD 호출 차단 (403)
- [ ] 비로그인 유저의 목록/상세 조회 허용 (200)
- [ ] 페이징 동작 확인 (page, pageSize, totalCount)

### 3.9 다음 Phase 연결 지점

Phase 1 완료 시점에 다음 조건이 만족되어야 Phase 2 진행 가능:
1. `tournament` 테이블에 OPEN 상태의 대회가 존재
2. `requireGuildManager` 미들웨어 사용 가능
3. 대회 상태 조회 헬퍼 (`getTournamentOrThrow(id)`) 서비스 레이어 노출

---

## 4. 다른 대화창에서 이어가기

### 4.1 진입 방법
새 대화에서 다음과 같이 시작:
```
@tournament-system-plan-phase1.md 읽고, Phase 1 백엔드 구현 시작해줘.
브랜치: claude/add-plan-recommendations-ZnuZ0 (loltrix_be)
```

### 4.2 선행 조건 확인
- [ ] `guild_member` 테이블에 `role` 컬럼 존재 확인
- [ ] `account` 테이블 PK 타입 확인 (nanoid vs int) — Phase 2에서 FK 연결
- [ ] `multer`, `xlsx` 설치 확인 (Phase 3용이지만 미리 준비)

### 4.3 Phase 1 착수 순서
1. Drizzle 스키마 파일 생성 (`tournament.schema.ts`)
2. 마이그레이션 생성 및 적용
3. Zod DTO 정의 (`tournament.types.ts`)
4. Repository → Service → Controller → Route 순으로 구현
5. `requireGuildManager` 미들웨어 작성
6. Swagger 문서 연동
7. 통합 테스트 (위 3.8 체크리스트)

---

## 부록 A. 설계 원칙 (공통)

1. **PK는 nanoid 21자**. auto-increment 사용 금지.
2. **Soft delete** (`is_deleted`) 우선, hard delete는 재해복구용.
3. **jsonb meta 컬럼** 을 모든 주요 테이블에 배치해 스키마 변경 최소화.
4. **상태 전이는 단방향**. 롤백이 필요하면 새 레코드로.
5. **권한 체크는 미들웨어 한 곳에서** — controller에서 중복 검사 금지.
6. **Validation은 Zod 단일 진입점**. DB 제약은 2차 방어선.
7. **응답 포맷 일관**: `{ data, error, meta }` 또는 직접 객체 — 프로젝트 컨벤션 확인 후 결정.

---

## 부록 B. 미해결 질문 (Phase 1)

- [ ] 응답 래퍼 포맷이 프로젝트에 이미 있는지? → `loltrix_be` 기존 코드 확인 필요
- [ ] `guild_member.role` 의 정확한 enum 값 (`manager` / `MANAGER` / `admin`?) → 기존 코드 확인 필요
- [ ] Swagger 자동 생성 사용 여부 → `src/swagger.ts` 검토 필요

---

**문서 버전**: v1.1
**최종 수정**: 2026-04-14
**대상 Phase**: 1 (대회 생성/관리 기반)
