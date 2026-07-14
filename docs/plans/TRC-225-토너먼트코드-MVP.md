# TRC-225 토너먼트코드 MVP 구현 계획 — 백엔드 (dev 키 + tournament-stub-v5)

> 티켓: [TRC-225](https://trcgg.atlassian.net/browse/TRC-225) (백엔드 파트 하위 작업)
> 공통 우산: [TRC-224](https://trcgg.atlassian.net/browse/TRC-224) `[공통] 토너먼트코드 MVP 도입`
> 봇 파트 계획: [TRC-226](https://trcgg.atlassian.net/browse/TRC-226) — `bot/trcgg_bot/docs/plans/TRC-226-토너먼트코드-MVP-봇연동.md` 상호 참조.

## 배경 / 문제

- 기획: [docs/tournament/토너먼트코드 도입.md](../tournament/토너먼트코드%20도입.md) (9754a4c)
- 재검토: [2026-07-06-토너먼트코드-도입-재검토.md](2026-07-06-토너먼트코드-도입-재검토.md) —
  **2026-07-07 Go 판정** (ARRA.gg 반례로 킬 조건 충족)
- 목표: 개발 키 + stub로 전체 플로우를 구현한 MVP → 프로덕션 키 + Tournaments API 신청 근거

코드베이스 실사(2026-07-06) 결과 기획서 대비 보정된 사실:

- Riot API 호출 코드 전무 → 클라이언트 전체 신규 (기존 `fetchWithTimeout.ts`는 Discord 전용)
- 기존 statsJson→DB 매핑(`matchParticipant.service.ts`, `mmrMetric.service.ts`)은
  리플 포맷 강결합 → Match-V5용 어댑터 별도 필요
- 스케줄러 인프라 전무 → 폴백 폴링은 스케줄러 도입부터
- CI/CD·무중단 배포는 이미 동작 (기획서의 "CD 마무리"는 콜백 HTTPS 노출 설정으로 축소)

## 목표 / 비목표

**목표**

1. stub 기반 발급 체인(provider→tournament→codes) + 코드 저장
2. 콜백 수신 + 검증 + Match-V5/timeline 수집 (stub는 콜백이 안 오므로 시뮬레이터로 검증)
3. Match-V5 → 기존 스키마 정규화 적재 + 밴픽 신설
4. 프로덕션 키 신청 자료 (플로우 시연 가능 상태)

**비목표**

- timeline 데이터의 기능화(골드 그래프 등) — 적재 설계만 후순위로
- 리플 업로드 경로 변경 — 병행 운영, 기존 코드 불변
- 프론트 소개 페이지 (별도 front 티켓)

## 변경 범위 (파일·API·스키마)

### 신규 모듈

| 항목 | 위치(제안) | 내용 |
|---|---|---|
| Riot API 클라이언트 | `src/clients/riot/` | 키 env 관리, 429 rate limit(Retry-After) 대응, 리전 라우팅(KR/asia), `RIOT_TOURNAMENT_STUB` 플래그로 stub↔prod 전환 |
| 토너먼트 서비스 | `src/services/tournament.service.ts` | provider/tournament 등록(1회성), 코드 발급(count 선발급), 상태 관리 |
| 콜백 컨트롤러 | `src/controllers/riotCallback.controller.ts` | 시크릿 경로 검증 → gameId로 match-v5 재검증(`info.tournamentCode` 대조) → 적재 트리거 |
| Match-V5 어댑터 | `src/services/matchV5Adapter.service.ts` | match-v5 JSON → `match_participant`/`mmr_participant_metric` 정규화 (기존 Zod 스키마 패턴 준수) |
| 적재 파사드 | `src/facade/tournamentSave.facade.ts` | 단일 트랜잭션 적재 — `replaySave.facade.ts`와 동일 순서, riot_account upsert 등 공통부 재사용 |
| 폴링 잡 | `src/jobs/tournamentPolling.job.ts` | `node-cron` 인프로세스. PENDING N시간 코드 → `games/by-code` 조회 |

### 라우트 (⚠️ 배치 제약)

- `POST /callback/riot/:secret` — **`src/routes/index.ts:23`의
  `restrictBotToLocalhost, verifyAuth` 라인보다 위**(health/auth 구역)에 등록.
  세션 없는 외부 호출이므로 인증 체인 아래 두면 전부 401.
- `POST /tournament/codes` 등 발급 API — 봇 전용이므로 기존 인증 체인 아래(localhost 제한) 구역.

### 스키마 (Drizzle + 수기 SQL)

- `schema.ts`에 추가: `tournament_provider`(1행), `tournament`, `tournament_code`
  (code, guild_id, custom_match_id, metadata jsonb, status PENDING/COMPLETED/INVALID, 발급/사용 시각)
- 밴픽: `match_ban` (custom_match_id, team, champion_id, ban_order)
- `migrations/008_tournament_code.sql` 수기 작성 (기존 001~007 패턴), 서버 수동 적용

## 단계별 작업

- [x] 0. 티켓 발급(우산 TRC-224 / 백엔드 TRC-225 / 봇 TRC-226)·본 문서 개명·브랜치 생성(`TRC-225-Back-토너먼트코드-MVP`) 완료
- [x] 1. Riot API 클라이언트 (stub 토글, rate limit, 키는 env로만 — ecosystem.config 평문 금지)
      — `src/clients/riot/` 6파일. 리뷰 완료(Fable)
- [x] 2. 스키마 3+1 테이블 + 마이그레이션 008 — schema.ts append + `migrations/008_tournament_code.sql`.
      결정: PK는 schema.ts 관례(`GENERATED ALWAYS AS IDENTITY`) 우선, `tournament_code`는 code 자연키,
      `match_ban.champion_id`는 nullable(밴 없음 -1 대응)·FK 미설정. 리뷰 완료(Fable)
- [x] 3. 발급 체인: provider/tournament 등록 스크립트 + 코드 발급 API (count 선발급)
      — 등록은 멱등(활성 행 재사용, `forceReregister`로 dev 키 재발급 대응). `POST /tournament/codes`
      (봇 전용 구역, channelId→metadata), `GET /tournament/next-code`. 리뷰 완료(Fable)
- [x] 4. 콜백 엔드포인트 + match-v5 재검증 + **콜백 시뮬레이터**(stub는 실제 콜백이 안 오므로
      로컬 테스트 스크립트로 POST 재현)
      — 시크릿 sha256+timingSafeEqual, 불일치 시 notFoundHandler 폴스루로 404 위장.
      미인정 콜백은 200 ignored ack(재시도 폭주 방지). 리뷰 완료(Fable)
      ⚠️ **단계 5 필수 반영**: 현재 검증 통과 시 즉시 `markCompleted` — 적재가 붙으면
      상태 전이를 적재 트랜잭션 안으로 이동할 것 (적재 실패 시 COMPLETED로 남아
      폴링(PENDING 대상)이 건너뛰어 기록 유실되는 경로 차단)
- [ ] 5. Match-V5 어댑터 + tournamentSave 파사드 (played_date=gameStartTimestamp, 밴픽 저장)
- [ ] 6. 폴백 폴링 잡 (node-cron 도입)
- [ ] 7. E2E 검증: 발급→시뮬 콜백→적재→기존 전적 화면에서 조회 확인
- [ ] 8. (프로덕션 키 수령 후) 실경기 1판으로 Match-V5 조회 실증 — **#1156 리스크 게이트**

구현 담당: **Opus** (본 계획 승인 후 전환). 기획·리뷰: Fable.

## 영향받는 불변식 / 리스크

- **리플 경로 불변**: `replaySave.facade.ts`/`replay.service.ts` 수정 금지. 공통화가 필요하면
  추출은 하되 기존 동작·트랜잭션 순서 유지 (intent-guard: replaySave 트랜잭션 순서는
  guild→replay→riot_account→custom_match→participant→metric 순으로 의도된 것)
- **콜백 무인증 방어 불변식**: 콜백 페이로드는 절대 신뢰하지 않는다 — match-v5 재검증으로
  `info.tournamentCode`가 DB 코드와 일치할 때만 적재 (기획 문서 §보안)
- dev 키 24h 만료 → provider 재등록 필요. 등록 스크립트를 멱등하게 만들 것
- `played_date` 의미가 경로별로 다름(리플=업로드 시각, 코드=실경기 시각) —
  혼합 조회 시 정렬·집계 영향 검토 필요
- 마이그레이션 자동 실행기 부재 — 배포 시 수동 psql 적용 절차를 PR 본문에 명시

## 검증 방법

- 단위: Match-V5 어댑터 (실제 match-v5 응답 fixture로 매핑 검증, Zod 스키마)
- 통합: 콜백 시뮬레이터로 발급→콜백→적재 E2E, status 전이(PENDING→COMPLETED) 확인
- 위조 콜백 거부 테스트: 잘못된 secret / DB에 없는 코드 / tournamentCode 불일치 3케이스
- 폴링: PENDING 코드 강제 생성 후 잡 1회 실행으로 회수 확인
