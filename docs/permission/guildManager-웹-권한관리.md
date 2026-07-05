# guildManager 웹 권한 관리 (uploader 부여/회수 · allowAllUploads)

> 확정된 사실 + 왜. (계획: `docs/plans/2026-07-03-guildmanager-uploader-grant-*.md`, 티켓: TRC-222)
> 이 기능을 변경하면 이 문서도 같은 작업에서 갱신한다.

## 무엇

웹에서 `guildManager`가 자기 길드의 Discord 멤버에게 `userUploader` 권한을 부여/회수하고,
길드의 `allowAllUploads`(전체 업로드 허용) 플래그를 토글한다. 관리 대상은 **Discord 멤버**
(`discord_member_role` 기준)이며 라이엇 계정(`guild_member`)과는 별개다 — 권한은 Discord id에 붙는다.

## API 계약 (확정)

모든 엔드포인트는 세션 인증(`verifyAuth`) 뒤 `requireGuildRole('guildManager')`로 보호된다
(adminNormal 이상 bypass). 경로의 `guildId`는 **Base64 인코딩**(`decodeGuildIdMiddleware`) —
프론트는 3개 모두 Base64 guildId로 호출한다.

### `GET /api/guildMember/{guildId}/discord-members?search=&page=&limit=`
- 반환: `{ memberId, displayName, role }[]` + 페이지 헤더(`X-Total-Count`/`X-Page`/`X-Limit`/`X-Total-Pages`).
- 대상: 해당 guildId에 `discord_member_role` 행이 있는 멤버(= 웹 로그인 이력자)만.
- `displayName` = `COALESCE(discord_guild_member.nickname, discord_member.display_name, member_id)`.
- `search`: displayName 부분일치(대소문자 무시, LIKE 이스케이프).

### `PATCH /api/guildMember/{guildId}/discord-members/{memberId}/role`
- body: `{ role: 'userNormal' | 'userUploader' }`.
- 응답 data: `{ memberId, guildId, role, changed }`. `changed=false`면 idempotent no-op(이미 같은 역할).
- 실패: 대상 역할 행 없음 → 404, 대상이 guildManager 이상 → 403.

### `PATCH /api/guilds/{guildId}/allow-all-uploads`
- body: `{ allowAllUploads: boolean }`. 응답 data: 갱신된 guild.

## 확정 결정 (왜)

1. **별명 저장 = 신규 테이블 `discord_guild_member`** (`unique(member_id, guild_id)`).
   정규화 위해 역할 테이블에 얹지 않음. 표시명 식별 전용.
2. **감사 추적 = append-only `discord_member_role_log`** (`from_role`/`to_role`/`actor_member_id`).
   "언제 부여/회수"는 이벤트 이력이라 컬럼 한 칸(grantedBy)으론 마지막 값만 남아 유실 → 별도 로그.
   실제 역할 변경이 있을 때만 INSERT(idempotent no-op은 로그 없음).
3. **별명 수집 경로 = 기존 `enrichWithNick` 재사용**. OAuth 스코프 `guilds.members.read`로
   `GET /users/@me/guilds/{guildId}/member`를 이미 호출 중. `GET /api/auth/guilds`(getGmokGuilds)
   시점에 `discord_guild_member`로 upsert(best-effort — 실패해도 길드 조회 흐름 유지).
4. **멤버 목록 = 웹 로그인 이력자만**. 역할 행이 웹 로그인 시에만 생성되는 기술적 필연.
   화면 안내 문구로 공백 메움("웹 로그인 이력이 있는 멤버만 표시됩니다").
5. **allowAllUploads는 플래그 전용 엔드포인트 신설**. 기존 `PUT /api/guilds/:id`는 adminNormal 전용 —
   전체 수정 권한을 넓히지 않고 이 플래그만 guildManager 스코프로 바꾸는 별도 라우트.
6. **guildId 인코딩 규칙 = 전달 위치 기준** (2026-07-05 확인된 기존 의도). guildId가
   **URL(경로/쿼리)에 실릴 때만 Base64** 인코딩하고, **body로 전달될 때는 raw** — body는 URL처럼
   노출/로깅되지 않아 인코딩할 이유가 없다는 판단. 기존 라우트도 이 패턴을 따름
   (`PUT /status`·`POST /sub-account`는 body라 raw, `GET /:guildId/...`는 path라 디코드).
   신규 PATCH 2개는 guildId가 path에 있으므로 Base64 적용이 규칙대로다.
   주의: raw id를 path에 직접 보내면 예외 없이 쓰레기로 디코드되어 오해성 403이 나는 함정이
   있으나, 프론트 훅(`useGuildManagement.ts`)이 btoa 인코딩을 쓰므로 실제 경로는 안전.
7. **봇 우회(req.isBot) 수용** (2026-07-05 리뷰 결정). `requireGuildRole`은 봇 요청을 무조건
   통과시키는 전역 패턴이라 이 라우트도 봇이 권한 검사 없이 호출 가능하고, 그 경우 감사 로그
   actor는 `'bot'`으로 기록됨. 봇 시크릿 = 서버 접근 동급의 신뢰 주체라는 기존 위협 모델을 따름.
   trcgg_bot은 현재 이 라우트를 사용하지 않음 — **봇이 유저 명령을 프록시해 이 API를 쓰게 되면
   실제 행위자 Discord id를 전달하는 방식(헤더 등)을 먼저 설계할 것** (actor 귀속 유실 방지).

## 불변식 (깨면 안 됨)

- `discord_member_role` `unique(member, guild)` 유지 — 부여/회수는 **UPDATE**(신규 행 X). (커밋 55d3712)
- **권한 상승 차단** — `grantOrRevokeRole`이 대상 현재 역할이 guildManager 이상이면 거부,
  toRole은 타입/zod로 `userUploader` 상한. enum 외 role 값(레거시/수동)은 409로 조작 거부
  (hasMinRole이 미지 값에 false를 반환해 가드가 뚫리는 것 방지).
- **동시성** — 부여/회수는 대상 행을 `SELECT ... FOR UPDATE`로 잠근 뒤 검사·변경
  (감사 로그 중복/lost update 방지).
- **별명 upsert는 성공값만** — enrichWithNick 실패(nick=undefined) 항목은 upsert에서 제외.
  일시 장애가 저장된 별명을 NULL로 덮어쓰지 않게 함. upsert는 fire-and-forget(응답 비블로킹).
- **길드 스코프** — 모든 조회·변경은 요청 guildId로 한정.
- `allowAllUploads` 의미(커밋 3598771, `requireUploadPermission`): true=인증자 전원 업로드, false=userUploader+.

## 파일맵

| 레이어 | 파일 |
| --- | --- |
| 스키마 | `src/database/schema.ts`, `migrations/008_add_guild_member_role_management.sql` |
| 서비스 | `src/services/discordGuildMember.service.ts`(별명 upsert), `discordMemberRole.service.ts`(목록·부여/회수), `guild.service.ts`(allowAllUploads) |
| 컨트롤러 | `src/controllers/guildMember.controller.ts`, `guild.controller.ts`, `discordAuth.controller.ts`(upsert 호출) |
| 라우트 | `src/routes/guildMember.routes.ts`, `guild.routes.ts` |

## 후속작업 (별도 티켓)

- 웹 리플 파일 삭제(userUploader 이상) — 현재 삭제 API는 guildManager 이상 요구, 권한 하향 결정 선행 필요.
- 클랜원 복귀/탈퇴 웹 화면 — 기존 `PUT /api/guildMember/status` 활용.
