# API 전수 점검 — 엔드포인트 목록

> 목적: 전체 API를 한 곳에 모아, 엔드포인트별 기능 점검 → 개선점 정리의 기준 문서로 사용한다.
> base path: 모든 라우트는 `/api` 하위 (`src/index.ts` → `app.use('/api', apiRoutes)`).
> 라우트 등록: `src/routes/index.ts`.

## 인증 정책 (라우터 마운트 순서 기준 — `src/routes/index.ts`)

- `/api/health`, `/api/auth/*` : **인증 불필요** (공개)
- 그 외 전부 : `restrictBotToLocalhost` → `verifyAuth` 적용 (세션 쿠키 `session_uid`, 봇은 `x-discord-bot`)
- `/api/test/*` : `NODE_ENV === 'development'` 에서만 등록
- 개별 라우트의 추가 권한(`requireAdmin` / `requireGuildRole` / `requireUploadPermission`)은 점검 단계에서 라우트별로 채운다.

---

## 1. Health — `health.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 1 | GET | `/api/health` | 헬스체크 | 공개 | ✅ |

## 2. Auth (Discord OAuth) — `discordAuth.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 2 | GET | `/api/auth/login` | 디스코드 로그인 시작 | 공개 | 🔴 |
| 3 | GET | `/api/auth/callback` | 디스코드 로그인 콜백 | 공개 | ✅ |
| 4 | POST | `/api/auth/logout` | 로그아웃 | 공개 | ✅ |
| 5 | GET | `/api/auth/me` | 내 정보 조회 | 인증 | 🔴 |
| 6 | GET | `/api/auth/gmokGuilds` | 내 길드 목록 조회 | 인증 | ✅ |

\* `/me`, `/gmokGuilds` 는 라우트에 `verifyAuth` 인라인 적용 → **인증 필요** (점검 시 확인 완료).
점검 칸: ✅ 이상없음 · 🔴 버그발견(→ api-review.md) · 🟡 개선권장

## 3. Guilds — `guild.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 7 | POST | `/api/guilds` | 새 길드 생성 | adminNormal | 🟡 |
| 8 | GET | `/api/guilds` | 길드 목록 조회 | 인증 | ✅fix |
| 9 | GET | `/api/guilds/:id` | 길드 상세 조회 | 인증 | ✅ |
| 10 | PUT | `/api/guilds/:id` | 길드 정보 수정 | adminNormal | 🔵 |
| 11 | DELETE | `/api/guilds/:id` | 길드 삭제 | adminNormal | ✅fix |

## 4. Replays — `replay.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 12 | GET | `/api/replays/:guildId` | 리플레이 목록 조회 | 인증 | ✅ |
| 13 | POST | `/api/replays` | 리플레이 생성 (디스코드 봇, JSON) | 인증/봇 | ✅ |
| 14 | POST | `/api/replays/web` | 웹 리플레이 업로드 (multipart) | 인증+업로드권한 | 🔵 |

## 5. Guild Member — `guildMember.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 15 | POST | `/api/guildMember/sub-account` | 부계정 연결 | guildManager | 🟡fix |
| 16 | GET | `/api/guildMember/:guildId/members` | 멤버 목록 조회 | 인증 | ✅ |
| 17 | GET | `/api/guildMember/:guildId/sub-accounts` | 부계정 목록 조회 | 인증 | ✅ |
| 18 | GET | `/api/guildMember/:guildId/:riotName` | 길드 멤버 검색 | 인증 | 🔵 |
| 19 | PUT | `/api/guildMember/status` | 멤버 상태 변경 (탈퇴/복귀) | guildManager | ✅ |
| 20 | DELETE | `/api/guildMember/sub-account` | 부계정 연결 해제 | guildManager | 🔵 |

## 6. Matches — `matchParticipant.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 21 | GET | `/api/matches/:guildId/:riotName/games` | 최근 게임 목록 조회 | 인증 | 🟡fix |
| 22 | GET | `/api/matches/:guildId/:riotName/dashboard` | 전적 대시보드 조회 | 인증 | ✅ |
| 23 | GET | `/api/matches/:guildId/:riotName/most-picks` | 모스트 픽 상세 조회 | 인증 | 🟡fix |
| 24 | GET | `/api/matches/:guildId/games/:gameId` | 게임 상세 조회 | 인증 | ✅ |
| 25 | DELETE | `/api/matches/:guildId/games/:gameId` | 게임 기록 삭제 | guildManager | 🟡fix |

## 7. Statistics — `statistics.route.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 26 | GET | `/api/statistics/:guildId/users` | 유저별 게임 통계 | 인증 | 🟡fix |
| 27 | GET | `/api/statistics/:guildId/champions` | 챔피언별 통계 | 인증 | 🟡fix |

## 8. H2H (상대전적) — `h2h.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 28 | GET | `/api/h2h/:guildId/frequent` | 자주 만난 상대 목록 | 인증 | ✅ |
| 29 | GET | `/api/h2h/:guildId` | 상대전적 상세 (맞붙은 + 함께한) | 인증 | ✅ |

## 9. Examples (샘플/참고) — `example.routes.ts`

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 30 | POST | `/api/examples` | 예제 생성 | 인증 | 🔵 |
| 31 | GET | `/api/examples` | 예제 목록 | 인증 | 🔵 |
| 32 | GET | `/api/examples/:id` | 예제 상세 | 인증 | 🔵 |

## 10. Test (개발 전용) — `test.routes.ts`  *(NODE_ENV=development 에서만 등록)*

| # | Method | Path | 설명 | 인증 | 점검 |
|---|---|---|---|---|---|
| 33 | GET | `/api/test/error/generic` | 일반 에러 로깅 테스트 | 인증/dev | ✅ |
| 34 | GET | `/api/test/error/validation` | 검증 에러 테스트 | 인증/dev | ✅ |
| 35 | GET | `/api/test/error/database` | DB 에러 테스트 | 인증/dev | ✅ |

---

## 집계

- 총 엔드포인트: **35개** (운영 32 + 개발 전용 test 3)
- 라우터 그룹: 10개 (health, auth, guilds, replays, guildMember, matches, statistics, h2h, examples, test)

## 점검 진행 방식 (다음 단계)

1. 각 엔드포인트별로 라우트 → 컨트롤러 → 서비스 흐름을 따라가며 기능 점검
2. 발견한 개선점은 별도 `docs/api/api-review.md`(가칭)에 엔드포인트 번호로 매핑해 정리
3. 점검 칸(⬜→✅) 갱신

### 이미 발견된 개선점 (사전 기록)
- **#15 / #20 부계정 연결·해제 (`guildMember.service.ts`)**: 연결(link) 시 `match_participant` / `mmr_participant_metric`의 `player_code` UPDATE에 `guildId` 스코프가 없어, 한 계정이 여러 길드에 참여할 경우 연결하지 않은 다른 길드의 부캐 전적까지 본캐로 병합됨. (연결 해제 시 원복 미수행은 의도된 동작으로 확인됨)
