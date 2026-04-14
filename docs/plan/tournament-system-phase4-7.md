# LoL 내전 대회 시스템 — Phase 4~7 로드맵 (v2.0)

> v1.0 (Phase 1~3) 완료 후 착수하는 **v2.0 확장 기능** 로드맵.
> 이 문서는 상세 설계가 아닌 **개요 + 선행 조건 + 체크리스트** 수준이다.
> 각 Phase 착수 시점에 별도 상세 설계 문서 작성 예정.

---

## 0. v2.0 전체 개요

### 0.1 v1.0 → v2.0 달라지는 점
| 항목 | v1.0 | v2.0 |
|------|------|------|
| 팀 편성 방식 | EXCEL only | EXCEL + DRAFT_FLAT + SNAKE_TIERED + AUCTION |
| 실시간성 | 없음 | WebSocket 기반 실시간 드래프트/경매 |
| 프론트 | 최소 관리자용 | 참가자용 풀 UI + 데모 페이지 |
| 관전 | N/A | 라이브 관전 모드 |

### 0.2 Phase 의존성
```
Phase 4 (WebSocket 인프라)
   │
   ├──▶ Phase 5 (DRAFT_FLAT)
   │
   ├──▶ Phase 6 (SNAKE_TIERED)
   │
   └──▶ Phase 7 (AUCTION)

Phase 8 (프론트 데모) ← v1.0 완료 후 언제든 병행 가능
```

---

## 1. Phase 4 — WebSocket 인프라

### 1.1 목표
Phase 5~7 의 공통 기반이 되는 실시간 통신 인프라 구축.

### 1.2 스코프
- WebSocket 서버 설정 (ws / socket.io 선택)
- 대회별 room 네임스페이스 (`tournament:{id}`)
- 인증 미들웨어 (세션 공유)
- 이벤트 라우팅 기반 구조 (`draft:*`, `auction:*`)
- 재연결/하트비트 처리

### 1.3 핵심 결정 사항 (착수 시 논의)
- [ ] 라이브러리: `ws` (경량) vs `socket.io` (기능 풍부)
- [ ] 상태 저장소: 메모리 vs Redis (다중 서버 대비)
- [ ] 인증 방식: 세션 공유 vs JWT
- [ ] 이벤트 포맷: `{ type, payload, ts }` 표준화

### 1.4 스키마 (잠정)
```ts
// 이벤트 감사 로그 (선택)
tournament_event_log
  id, tournament_id, event_type, actor_account_id,
  payload jsonb, created_at
```

### 1.5 API / 이벤트 (예시)
| 방향 | 이벤트 | 설명 |
|------|--------|------|
| S→C | `state:sync` | 현재 드래프트/경매 상태 전체 |
| S→C | `participant:joined` | 관전자 입장 |
| C→S | `ping` | 하트비트 |

### 1.6 체크리스트
- [ ] WebSocket 서버 기동
- [ ] 대회 룸 입장/퇴장
- [ ] 세션 기반 인증 통과
- [ ] 재연결 시 상태 복구
- [ ] 이벤트 감사 로그 기록

---

## 2. Phase 5 — DRAFT_FLAT (평평한 드래프트)

### 2.1 목표
티어 구분 없이 캡틴들이 **순서대로** 참가자를 픽하는 방식.

### 2.2 룰
- 캡틴 = `is_captain_candidate=true` 중 운영자가 `team_count` 명 지정
- 픽 순서 예시 (4팀):
  - 1라운드: `T1, T2, T3, T4`
  - 2라운드: `T4, T3, T2, T1` (스네이크)
  - 또는 고정 순서 옵션 지원
- 픽 제한 시간 (예: 30초) — 초과 시 자동 랜덤 픽
- 캡틴은 본인 팀에 픽된 참가자만 볼 수 있는 게 아니라 **전체 공개**

### 2.3 스키마 변경
```ts
tournament_team_member.pick_order  int   -- 픽 순서 기록 (1부터)

-- 드래프트 세션 상태
tournament_draft_session
  id, tournament_id, status (WAITING|IN_PROGRESS|DONE),
  current_pick_order int, turn_deadline timestamptz,
  meta jsonb, created_at
```

### 2.4 API / 이벤트
| 방향 | 이벤트 | 설명 |
|------|--------|------|
| C→S | `draft:pick` | 캡틴이 참가자 픽 |
| S→C | `draft:picked` | 전체 브로드캐스트 |
| S→C | `draft:turn_change` | 다음 캡틴 차례 |
| S→C | `draft:timeout` | 시간 초과 자동 픽 |
| S→C | `draft:done` | 드래프트 종료 |

### 2.5 REST (보조)
| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/tournaments/:id/draft/start` | 드래프트 시작 (manager) |
| POST | `/api/tournaments/:id/draft/captains` | 캡틴 지정 (manager) |
| GET | `/api/tournaments/:id/draft/state` | 현재 상태 조회 |
| POST | `/api/tournaments/:id/draft/abort` | 중단 (manager) |

### 2.6 체크리스트
- [ ] 캡틴 지정 → 남은 참가자 풀 자동 구성
- [ ] 순차 픽 동기화 (중복 픽 방지)
- [ ] 타임아웃 자동 랜덤 픽
- [ ] 중단/재개 지원
- [ ] 완료 시 `tournament_team_member` 일괄 저장
- [ ] 관전자 입장 허용 (읽기 전용)

---

## 3. Phase 6 — SNAKE_TIERED (티어별 스네이크)

### 3.1 목표
참가자가 **티어별**로 분류되어 있고, 각 팀이 **티어마다 1명씩** 가져가는 방식.

### 3.2 룰
- 운영자가 참가자에 내부 티어(1~N) 부여 (Phase 3 `tier-upload` 활용)
- 각 티어별 인원 = `team_count` (예: 5티어 × 4팀 = 20명)
- 픽 순서: **티어 1 → 티어 2 → ...** 순차 진행
- 티어 내 스네이크: 1팀→2팀→3팀→4팀, 다음 티어에선 4팀→3팀→2팀→1팀
- 한 팀에 **동일 티어 2명 금지** (스키마 제약)

### 3.3 스키마 변경
- Phase 3에서 이미 `tournament_participant.tier` 존재
- 추가 제약 (애플리케이션 레벨):
  ```sql
  -- 한 팀 내 동일 tier 중복 금지
  UNIQUE (team_id, participant.tier)  -- 쿼리/체크로 구현
  ```

### 3.4 API / 이벤트
DRAFT_FLAT 과 동일 구조 + 티어 컨텍스트:
| 이벤트 | 추가 payload |
|--------|------|
| `draft:turn_change` | `currentTier`, `teamOrder` |
| `draft:pick` | 티어 일치 검증 |

### 3.5 체크리스트
- [ ] 티어별 인원 수 균형 검증 (사전)
- [ ] 픽 시 해당 티어 참가자인지 검증
- [ ] 한 팀 동일 티어 2명 방지
- [ ] 스네이크 순서 자동 계산
- [ ] 티어 전환 시점 브로드캐스트

---

## 4. Phase 7 — AUCTION (경매 방식)

### 4.1 목표
캡틴들이 **포인트**를 가지고 참가자에게 입찰하여 팀을 구성.

### 4.2 룰
- 각 캡틴에 시작 포인트 지급 (예: 1000)
- 참가자 1명씩 경매대에 등장 (순서: 무작위 / 티어순 선택)
- 캡틴들이 입찰 → 타이머 내 최고가 낙찰
- 연장(extend) 규칙: 타이머 종료 직전 입찰 시 +5초
- 팀당 인원 = `team_size` 채워지면 해당 팀 경매 종료
- 포인트 부족으로 남은 자리 채우는 강제 배정 규칙 필요

### 4.3 스키마
```ts
tournament_auction_session
  id, tournament_id, status, current_participant_id,
  bid_deadline timestamptz, meta jsonb

tournament_auction_bid
  id, session_id, participant_id, captain_participant_id,
  amount int, created_at

tournament_team_member.pick_order   -- 낙찰 순서
tournament_team_member.meta          -- { bidAmount: 150 }
```

### 4.4 API / 이벤트
| 방향 | 이벤트 | 설명 |
|------|--------|------|
| S→C | `auction:start` | 경매 시작 (참가자 공개) |
| C→S | `auction:bid` | 입찰 |
| S→C | `auction:bid_accepted` | 최고가 갱신 |
| S→C | `auction:extended` | 타이머 연장 |
| S→C | `auction:won` | 낙찰 |
| S→C | `auction:team_full` | 팀 인원 충족 |
| S→C | `auction:done` | 전체 종료 |

### 4.5 체크리스트
- [ ] 시작 포인트 설정 (대회별 옵션)
- [ ] 입찰 원자성 (동시 입찰 경합 처리)
- [ ] 타이머 연장 룰
- [ ] 포인트 차감/검증
- [ ] 팀 인원 충족 시 해당 팀 입찰 차단
- [ ] 남은 참가자 강제 배정 규칙
- [ ] 낙찰 이력 저장

---

## 5. Phase 8 — 프론트 데모 (병행 가능)

### 5.1 목표
`trcgg_front` 에 최소 동작 가능한 UI 구축. v1.0 범위로도 착수 가능.

### 5.2 스코프
- 대회 목록 페이지
- 대회 상세 페이지 (탭: 참가자 / 팀 / 일정)
- 참가 신청 폼
- 팀 편성 페이지 (엑셀 업로드)
- v2.0에서: 실시간 드래프트/경매 UI

### 5.3 기술 결정
- Next.js 12 + React 18 + TailwindCSS + React Query (기존 스택)
- WebSocket 클라이언트 (v2.0용)
- 엑셀 업로드: `react-dropzone`

### 5.4 체크리스트 (v1.0 범위)
- [ ] 대회 목록 / 페이징
- [ ] 대회 상세 (공개)
- [ ] 참가 신청 폼 (로그인 유저)
- [ ] 참가자 목록 (운영자 탭)
- [ ] 팀 편성 엑셀 업로드 UI
- [ ] 팀 탭 (공개)

---

## 6. 공통 사전 작업 (Phase 4 진입 전)

- [ ] v1.0 (Phase 1~3) 실제 길드 테스트 1회 이상
- [ ] v1.0 피드백 수집 및 우선순위 결정
- [ ] WebSocket 라이브러리/인프라 결정
- [ ] Redis 도입 여부 결정 (다중 서버 대비)
- [ ] 실시간 기능 장애 대응 플랜 (타임아웃/재접속)

---

## 7. 보류/백로그

| 항목 | 설명 | 우선순위 |
|------|------|---------|
| 팀 편성 히스토리 (audit log) | 편성 변경 이력 추적 | Low |
| 팀 편성 시뮬레이션 (dry-run) | 업로드 전 검증만 | Low |
| 대회 템플릿 복제 | 이전 대회 설정 재사용 | Mid |
| 참가자 평판/통계 연동 | `account` 레벨 집계 | Mid |
| Discord Bot 알림 연동 | 대회 생성/마감 알림 | Low (본 프로젝트 제외) |
| 모바일 반응형 UI | | Mid |

---

## 8. 문서 분리 원칙

각 Phase 착수 시 별도 상세 문서 작성:
- `docs/plan/tournament-system-phase4.md` (WebSocket 상세)
- `docs/plan/tournament-system-phase5.md` (DRAFT_FLAT 상세)
- `docs/plan/tournament-system-phase6.md` (SNAKE_TIERED 상세)
- `docs/plan/tournament-system-phase7.md` (AUCTION 상세)
- `docs/plan/tournament-system-phase8.md` (프론트 데모 상세)

---

**문서 버전**: v1.0 (Phase 4~7 개요)
**최종 수정**: 2026-04-14
**대상 Phase**: 4, 5, 6, 7 (+ Phase 8 병행)
