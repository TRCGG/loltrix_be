# 2026-07-03 guildManager의 웹 uploader 권한 부여 — Seed 명세

> AI 인터뷰(ai-interview) 결과로 확정된 **명세**. 계획(plans)이 아니라 "무엇을/왜"를 고정한 문서.
> 이 명세를 기준으로 backend / front 각 repo의 계획 파일을 작성한다.
> 관련: (A) 웹 리플 삭제 UI는 후속 작업.

## 한 줄 목표

웹에서 guildManager가 자기 길드의 멤버를 조회·검색해 특정 멤버에게 `userUploader` 권한을
부여/회수할 수 있게 한다. guildManager 이상은 조작 불가(권한 상승 차단), 변경 이력 추적 가능.
리플 삭제 UI(A)는 이번 범위 제외.
    
## Seed 명세

```yaml
goal: >
  웹에서 guildManager가 자기 길드의 멤버를 조회·검색해 특정 멤버에게
  userUploader 권한을 부여/회수할 수 있게 한다. 리플 삭제 UI(A)는 이번 범위 제외.

context: brownfield
  확인된 사실:
    - 역할 5단계: userNormal(0) < userUploader(1) < guildManager(2) < adminNormal(3) < adminSuper(4)
    - 역할 저장: discord_member_role 테이블, (member, guild) 당 1행(unique), guildId 스코프
    - 권한 부여 API 없음 (로그인 시 userNormal 자동 부여 / DB 직접 INSERT 뿐) → (B)는 신규 기능
    - 길드 스코프 검사 미들웨어 requireGuildRole(minRole, source) 재활용 가능
    - discord_member는 전역 1행(guildId 없음), displayName=global_name/username, guild 별명 미저장
    - Discord<->Riot 매핑 테이블 없음 → 식별은 Discord guild 별명으로 함
    - 프론트는 GET /api/auth/guilds로 길드별 내 role을 이미 수신 → UI 게이팅 가능

acceptance_criteria:
  - guildManager가 웹에서 멤버를 찾아 uploader 부여/회수하면 그 멤버의 업로드/삭제 권한이 실제로 생기거나 사라진다
  - guildManager가 다룰 수 있는 역할은 userNormal <-> userUploader 뿐 (guildManager 이상은 여전히 DB 수동 부여)
  - guildManager가 웹에서 자기 길드의 allowAllUploads(전체 업로드 허용) 여부를 토글하면 즉시 반영된다
  - guildManager 이상(guildManager·admin)과 타 길드 멤버는 조작 불가, 권한 없는 사용자는 화면/API 접근 자체가 차단된다
  - 부여/회수 후 목록에 역할이 즉시 반영되고, 같은 멤버에 중복 부여해도 에러 없이 idempotent 하다
  - 누가 누구에게 언제 부여/회수했는지 기록이 남아 추적 가능하다

constraints:
  - 권한 상한: guildManager는 userUploader까지만 조작 (권한 상승 차단)
  - 대상 범위: 자기 길드(guildId) 스코프 내 멤버만
  - 역할 저장은 (member, guild) 당 1행 UPDATE 방식 (신규 행 추가 아님) — unique 제약 유지
  - guild 별명은 길드 스코프로 저장(다길드 유저 정확성), 식별 표시명 = guild별명 ?? global ?? discord_id
  - 감사 추적을 위해 "누가 바꿨는지(grantedBy)" 정보 필요 (현재 스키마엔 없음)

out_of_scope:
  - guildManager 이상 역할의 부여/회수 — 웹에서 안 함. 여전히 DB 수동
  - 봇 측 권한 부여 기능 변경
  # 아래는 후속작업(별도 티켓) — 이번엔 안 함
  - (후속1) 클랜원 복귀/탈퇴 웹 화면 (현재 Discord 명령어로만, guildManager 이상) — 기존 PUT /api/guildMember/status 활용
  - (후속2) 웹 리플 파일 삭제 (userUploader 이상) — 권한 하향 결정 완료(2026-07-05, TRC-220): API는 userUploader로 하향, 봇 !drop은 그대로

ontology:
  - "멤버 표시명": 그 길드에서 지정한 Discord guild 별명. 없으면 global 별명, 그것도 없으면 Discord id
  - "부여(grant)": discord_member_role의 해당 (member, guild) 행을 userNormal->userUploader로 UPDATE
  - "회수(revoke)": 같은 행을 userUploader->userNormal로 UPDATE
  - "길드 스코프": 항상 guildId가 붙는 권한. guildManager의 조작 대상도 자기 guildId로 한정

open_questions:
  - guild 별명 수집 시점: 멤버 동기화/로그인 시 길드 컨텍스트에서 어떻게 채우나 (Discord API 조회 필요)
  - 검색 기준: 표시명(별명) 부분일치 / Discord id 등 어떤 키로 검색하나

repos_touched:
  - loltrixbe/loltrix_be: 멤버목록·검색 API, 역할 부여/회수 API, guild 별명 저장, 스키마/마이그레이션, 감사 기록
  - front/trcgg_front: guildManager 전용 멤버 관리 화면(목록+검색+부여/회수 토글), auth role 게이팅
```

## 확정 결정 (2026-07-04)

1. **guild 별명 저장 = 신규 테이블** `discord_guild_member` (역할 테이블에 얹지 않음 — 정규화).
   - `id, memberId(fk discord_member), guildId, nickname, createDate, updateDate, isDeleted`, `unique(memberId, guildId)`.
   - 비용: 목록 쿼리 시 `discord_member_role`과 조인, 로그인 시 role 행과 함께 생성/갱신.
2. **감사 추적 = 별도 append-only 로그 테이블** (예: `discord_member_role_log(id, memberId, guildId, actorMemberId, fromRole, toRole, createDate)`).
   - 이유: 요구사항이 "언제 부여/회수" = 이벤트 이력. 컬럼 한 칸(grantedBy)은 마지막 값만 남아 이력 유실.
3. **멤버 목록 대상 = 웹 로그인 이력자만** (= discord_member_role/discord_guild_member 행 존재자).
   - 이유: 역할 부여엔 discord_member 행이 필요한데 이 행은 웹 로그인 시에만 생성됨(기술적 필연).
   - UX: 화면에 "웹 로그인 이력이 있는 멤버만 표시됩니다" 안내 문구로 공백 메움.
4. **allowAllUploads 토글을 (B) 범위에 포함**. guildManager가 자기 길드의 `guild.allowAllUploads`(true/false)를 웹에서 변경.
   - 참고: 이 플래그는 `requireUploadPermission`(requireRole.ts)이 참조 — true면 인증자 전원 업로드 허용, false면 userUploader 이상 필요.
   - 주의: 기존 길드 수정 `PUT /api/guilds/:id`는 adminNormal 전용. 전체 수정 권한을 넓히지 말고, **이 플래그만** 바꾸는 별도 엔드포인트를 guildManager 스코프로 신설.

## 후속작업 (별도 티켓, 이번 범위 아님)

1. **클랜원 복귀/탈퇴 웹 화면** — 현재 Discord 명령어로만(guildManager 이상). 기존 `PUT /api/guildMember/status`(본계정 변경 시 부계정 동반 처리 로직 있음) 활용.
2. **웹 리플 파일 삭제 (A)** — 대상 권한 = userUploader 이상.
   - ~~인텐트 주의: userUploader로 낮추려면 해당 코드 git 이력 확인 후 결정.~~
   - **결정 완료(2026-07-05, TRC-220)**: git 이력 확인(가드 도입 = TRC-217 a394266, 무보호 파괴적 작업 보호 목적) 후
     `DELETE /api/matches/{guildId}/games/{gameId}`를 userUploader로 하향(f37b125). 봇 `!drop`은 별도 체계라 관리자급 유지.
     남은 것은 프론트 삭제 UI.

## 참조 (조사로 확인된 코드 위치)

- 역할 정의: `loltrixbe/loltrix_be/src/types/role.ts`
- 역할 스키마: `loltrixbe/loltrix_be/src/database/schema.ts` (discord_member_role, discord_member)
- 권한 미들웨어: `loltrixbe/loltrix_be/src/middlewares/requireRole.ts` (requireGuildRole)
- 역할 서비스: `loltrixbe/loltrix_be/src/services/discordMemberRole.service.ts`
- 길드별 내 role 조회: `GET /api/auth/guilds` (discordAuth.controller.ts)
- 프론트 리플 화면: `front/trcgg_front/src/pages/replay/index.tsx`
