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

### guild 별명 수집 (open Q — 구현 초입에 확정)
- 로그인/동기화 시 길드 컨텍스트에서 guild nickname을 채워 `discord_guild_member` upsert.
- Discord API 길드 멤버 조회 경로 확인 필요 (봇 토큰/gateway vs OAuth 범위). **가장 리스크 큰 지점.**
- 참고: 역할 자동 생성 로직 `discordMemberRole.service.ts#ensureDefaultRolesForGuilds` 옆에 별명 upsert 병행.

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

- [ ] 0. `guild 별명 수집` Discord API 경로 확정 (open Q)
- [ ] 1. 스키마 2종 추가 + 마이그레이션
- [ ] 2. 로그인/동기화 시 `discord_guild_member` upsert (별명 fallback: guild→global→id)
- [ ] 3. 멤버 목록 API (조인 + 검색/페이지네이션, guildManager 보호)
- [ ] 4. 역할 부여/회수 API (상한·경계 검사, idempotent, 감사 로그)
- [ ] 5. allowAllUploads 토글 API (플래그 전용 엔드포인트, guildManager 보호)
- [ ] 6. 테스트: 권한 경계(타 길드/상위역할/무권한 차단), idempotency, 로그 남는지, allowAllUploads 반영

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
- **웹 리플 삭제 (A)**: 대상 권한 userUploader 이상. **주의**: 현재 `DELETE /api/matches/{guildId}/games/{gameId}`는 guildManager 이상 요구(matchParticipant.routes.ts), 봇 `!drop`도 관리자급. userUploader로 낮추면 기존 권한 경계 변경 → 착수 시 git 이력 확인(왜 guildManager였는지) 후 결정.
