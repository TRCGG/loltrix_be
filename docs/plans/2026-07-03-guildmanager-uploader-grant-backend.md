# 2026-07-03 guildManager 웹 uploader 권한 부여 — 백엔드 계획

- 명세: [2026-07-03-guildmanager-uploader-grant-spec.md](./2026-07-03-guildmanager-uploader-grant-spec.md)
- 프론트 계획: `front/trcgg_front/docs/plans/2026-07-03-guildmanager-uploader-grant-frontend.md`

## 배경 / 문제

리플 삭제(및 업로드) 권한(`userUploader`)을 지금은 봇/DB 직접 조작으로만 줄 수 있다.
guildManager가 웹에서 자기 길드 멤버에게 `userUploader`를 부여/회수할 수 있게 한다.
멤버 식별은 Discord↔Riot 매핑이 없어 **guild 별명**(없으면 global → id)으로 한다.
(관련 의도: 역할 계층·guildId 스코프·unique(member,guild)는 기존 설계 — 구현 시 해당 파일 git 이력 확인.)

## 목표 / 비목표

- 목표: guildManager가 자기 길드 멤버 목록을 조회·검색하고 `userUploader`를 부여/회수.
- 비목표: (A) 웹 리플 삭제 UI, guildManager 이상 역할 조작, 봇 권한 부여 로직 변경.

## 변경 범위 (파일 · API · 스키마)

### 스키마 / 마이그레이션 (`src/database/schema.ts`)
- 신규 `discord_guild_member`: `id, memberId(fk discord_member), guildId, nickname, createDate, updateDate, isDeleted`, `unique(memberId, guildId)`.
- 신규 `discord_member_role_log`(append-only): `id, memberId, guildId, actorMemberId, fromRole, toRole, createDate`.

### guild 별명 수집 (open Q — ✅ 해결)
- **확정**: 별명 수집 경로가 **이미 존재**. `discordMemberGuild.service.ts#enrichWithNick`가
  OAuth 스코프 `guilds.members.read`로 `GET /users/@me/guilds/{guildId}/member`를 호출해
  길드별 `nick`을 조회함(현재는 표시용, 미저장). **리스크였던 지점이 실질적으로 해소됨.**
- 저장 지점: `GET /api/auth/guilds`(getGmokGuilds)의 non-admin 분기, `ensureDefaultRolesForGuilds`
  바로 뒤에서 `discordGuildMemberService.upsertGuildNicknames`로 upsert (best-effort, 실패해도 흐름 유지).
- nick fallback: 별명 없으면 NULL 저장 → 표시명은 조회 시 `COALESCE(nickname, display_name, member_id)`로 해소.

### API
- `GET /api/guildMember/{guildId}/discord-members?search=&page=&limit=`
  - 반환: `{ memberId, displayName(=별명??global??id), role }[]` — `discord_member_role` ⋈ `discord_guild_member` ⋈ `discord_member`.
  - 대상: 해당 guildId에 role 행 있는 멤버(웹 로그인자)만.
  - 보호: `requireGuildRole('guildManager', { from: 'params', key: 'guildId' })`.
- `PATCH /api/guildMember/{guildId}/discord-members/{memberId}/role`
  - body: `{ role: 'userUploader' | 'userNormal' }`.
  - 로직: 대상의 (member,guild) role 행을 UPDATE. 상한 검사(userUploader 초과 거부), 대상 현재 role이 guildManager 이상이면 거부. idempotent. 성공 시 `discord_member_role_log` 기록(actor = 요청자 memberId).
  - 보호: `requireGuildRole('guildManager', ...)`.
- `PATCH /api/guilds/{guildId}/allow-all-uploads` (allowAllUploads 토글)
  - body: `{ allowAllUploads: boolean }`.
  - 로직: `guild.allowAllUploads`만 UPDATE. (기존 `PUT /api/guilds/:id`는 adminNormal 전용 — 전체 수정 권한을 넓히지 말고 이 플래그 전용 엔드포인트 신설.)
  - 보호: `requireGuildRole('guildManager', { from: 'params', key: 'guildId' })`.

### 파일 (예상 신규/수정)
- `src/routes/guildMember.routes.ts` (라우트 추가)
- `src/controllers/guildMember.controller.ts` (핸들러 추가)
- `src/services/discordMemberRole.service.ts` (부여/회수 + 로그)
- `src/services/discordGuildMember.service.ts` (신규 — 별명 upsert/조회)
- `src/database/schema.ts`, 마이그레이션 파일

## 단계별 작업

- [x] 0. `guild 별명 수집` Discord API 경로 확정 (open Q) — enrichWithNick 이미 존재로 해소
- [x] 1. 스키마 2종 추가 + 마이그레이션 (`008_add_guild_member_role_management.sql`)
- [x] 2. 길드 조회(getGmokGuilds) 시 `discord_guild_member` upsert (별명 fallback: nick→NULL, 표시 시 COALESCE)
- [x] 3. 멤버 목록 API (조인 + 검색/페이지네이션, guildManager 보호)
- [x] 4. 역할 부여/회수 API (상한·경계 검사, idempotent, 감사 로그)
- [x] 5. allowAllUploads 토글 API (플래그 전용 엔드포인트, guildManager 보호)
- [~] 6. 테스트: **스킵** — BE에 test harness(jest config/기존 테스트) 전무. 레포 관례(테스트 0개)를 따라
      자동화 테스트 대신 아래 "검증 방법"의 수동/통합 검증에 의존. 필요 시 별도 티켓으로 harness 도입.

## 구현 결과 (2026-07-05)

- 타입체크(`tsc --noEmit`) 통과. 신규/수정 파일:
  - 스키마: `src/database/schema.ts` (discord_guild_member, discord_member_role_log), `migrations/008_*.sql`
  - 서비스: `src/services/discordGuildMember.service.ts`(신규, 별명 upsert),
    `src/services/discordMemberRole.service.ts`(getGuildMembersWithRoles, grantOrRevokeRole),
    `src/services/guild.service.ts`(updateAllowAllUploads)
  - 컨트롤러: `guildMember.controller.ts`(getGuildDiscordMembers, updateGuildMemberRole),
    `guild.controller.ts`(updateAllowAllUploads), `discordAuth.controller.ts`(별명 upsert 호출)
  - 라우트: `guildMember.routes.ts`, `guild.routes.ts` (guildManager 보호 + guildId Base64 decode)
- **guildId는 Base64 인코딩**이 guildManager 스코프 엔드포인트 관례 → 프론트(TRC-223)는 3개 엔드포인트 모두 Base64 guildId 전달.

## 영향받는 불변식 / 리스크

- **불변식 유지**: `discord_member_role` unique(member,guild) — 부여/회수는 UPDATE(신규 행 X).
- **권한 상승 차단**: guildManager가 guildManager/admin 부여·회수 못 하게 컨트롤러에서 상한/대상 role 검사.
- **길드 스코프**: 모든 조회·변경은 요청 guildId로 한정(타 길드 멤버 접근 불가).
- 리스크: guild 별명 수집(Discord API rate limit/권한). 여기 막히면 목록 식별력↓ → 임시로 global/id fallback로 진행 가능.

## 검증 방법

- guildManager 토큰으로 부여 → 대상이 `POST /api/replays/web`(allowAllUploads=false)에서 통과되는지.
- 회수 → 다시 차단되는지. 중복 부여 → 200 idempotent.
- 무권한/타 길드/상위역할 대상 → 403.
- `discord_member_role_log`에 이벤트가 쌓이는지.
- allowAllUploads 토글 → false에서 userNormal 업로드 차단, true에서 허용되는지.

## 후속작업 (별도 티켓, 이번 범위 아님)

- **클랜원 복귀/탈퇴 웹 화면**: 기존 `PUT /api/guildMember/status`(guildManager) 활용. 본계정 변경 시 부계정 동반 처리 로직 유의.
- **웹 리플 삭제 (A)**: 대상 권한 userUploader 이상. **하향 결정 완료(2026-07-05, TRC-220)** —
  git 이력 확인(가드 도입 = TRC-217 a394266, 무보호 파괴적 작업 보호) 후
  `DELETE /api/matches/{guildId}/games/{gameId}`를 userUploader로 하향
  (브랜치 `TRC-220-Back-웹-리플삭제-권한-하향`, f37b125). 봇 `!drop`은 관리자급 유지. 남은 것은 프론트 삭제 UI.
