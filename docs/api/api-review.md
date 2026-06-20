# API 기능 점검 — 개선점 정리

> [api-inventory.md](./api-inventory.md)의 엔드포인트 번호 기준으로 점검 결과·개선점을 기록한다.
> 심각도: 🔴 버그(동작 오류) · 🟡 개선 권장 · 🔵 참고/논의

---

## 1. Health

### #1 GET /api/health — ✅ 이상 없음
- 단순 200 JSON 반환. 문제 없음.

---

## 2. Auth (Discord OAuth)

### #2 GET /api/auth/login — 🔴 에러 처리 결함
- [discordAuth.controller.ts:27-34](../../src/controllers/discordAuth.controller.ts#L27-L34)
- `catch (error) { next(); }` — **에러 객체 없이 `next()` 호출**. Express에서 인자 없는 `next()`는 에러 핸들러가 아니라 다음 일반 미들웨어(결국 `notFoundHandler` → 404)로 흐름. 실제 실패 원인이 삼켜지고 사용자는 404를 받음. 로깅도 없음.
- 수정: `next(error)`로 변경(전역 errorHandler로 위임), 최소한 `console.error` 추가.

### #3 GET /api/auth/callback — 🟡 경미
- [discordAuth.controller.ts:41-70](../../src/controllers/discordAuth.controller.ts#L41-L70)
- 동작 정상(에러는 `next(err)` 위임). `req.connection.remoteAddress`는 deprecated API — `req.socket.remoteAddress` 권장. 프록시(Lightsail/nginx) 뒤라면 `req.ip`가 신뢰 가능하도록 `app.set('trust proxy', ...)` 설정 여부 점검 필요.

### #4 POST /api/auth/logout — ✅ 이상 없음
- 쿠키 제거 + 세션 폐기. try/catch에서도 쿠키 제거 후 리다이렉트하는 방어적 처리 양호.

### #5 GET /api/auth/me — 🔴 이중 응답 가능성
- [discordAuth.controller.ts:146-179](../../src/controllers/discordAuth.controller.ts#L154-L160)
- `if (!req.discordMemberId)` 분기에서 500 응답을 보내지만 **`return`이 없어** 이후 `fetchUser(accessToken)`까지 실행되고 두 번째 응답을 시도 → `ERR_HTTP_HEADERS_SENT` 위험.
- 수정: 해당 분기에 `return` 추가.
- (참고) 인벤토리에서 `/me`, `/gmokGuilds`를 "공개*"로 표기했으나 라우트에 `verifyAuth` 인라인 적용 → **실제 인증 필요**. 인벤토리 정정함.

### #6 GET /api/auth/gmokGuilds — ✅ 동작 정상 / 🔵 참고
- [discordAuth.controller.ts:101-139](../../src/controllers/discordAuth.controller.ts#L101-L139)
- admin/일반 분기, 기본 권한 보장 로직 정상. catch가 항상 500으로 뭉뚱그려 내려 BusinessError 구분이 안 됨(전역 errorHandler에 위임하면 상태코드 세분화 가능) — 다른 컨트롤러와 패턴 일관성 점검 대상.

---

---

## 3. Guilds

### #7 POST /api/guilds — 🟡 중복 guildId 처리
- [guild.controller.ts:15-41](../../src/controllers/guild.controller.ts#L15-L41) · [guild.service.ts:15-18](../../src/services/guild.service.ts#L15-L18)
- `insertGuild`는 평범한 insert. 이미 존재하는 guildId(또는 soft-delete된 동일 id)면 PK 충돌 → catch에서 일괄 500. **409 Conflict로 구분**하는 게 적절. 권한·검증·정상 흐름은 양호.

### #8 GET /api/guilds — 🟡 X-Total-Pages "NaN" (재발 패턴)
- [guild.controller.ts:94](../../src/controllers/guild.controller.ts#L94)
- `Math.ceil(totalCount / (Number(limit) ?? 10))` — `limit` 미입력 시 `Number(undefined)=NaN`이고 `NaN ?? 10`은 NaN(`??`는 nullish만 처리, NaN은 통과 못 함) → 헤더값 `"NaN"`.
- 바로 위 `X-Limit`은 `(limit ?? 10)`으로 올바르게 처리 → 두 줄이 불일치.
- **✅ 수정함**: `Number(limit) || 10`로 변경.
- ⚠️ **동일 패턴이 #23 most-picks([matchParticipant.controller.ts:226](../../src/controllers/matchParticipant.controller.ts#L226)) 등 다른 페이지네이션 응답에도 존재** → 해당 엔드포인트 점검 시 같이 수정.

### #9 GET /api/guilds/:id — ✅ 이상 없음
- isDeleted=false 필터, 404 분기 정상.

### #10 PUT /api/guilds/:id — 🔵 참고
- [guild.service.ts:88-95](../../src/services/guild.service.ts#L88-L95)
- where가 `isDeleted=false`라 **삭제된 길드는 복구(un-delete) 불가**(404). body로 `isDeleted:true`는 가능 → PUT으로도 소프트삭제 됨(의도 확인 필요). `updateDate` 미갱신.

### #11 DELETE /api/guilds/:id — 🟡 "이미 삭제됨" 분기 도달 불가
- [guild.service.ts:100-107](../../src/services/guild.service.ts#L100-L107)
- `softDeleteGuild` where가 `eq(guild.id, id)`뿐 — **isDeleted 필터 없음**. 이미 삭제된 길드도 update가 매칭돼 행 반환 → 컨트롤러의 404 "already deleted" 분기([guild.controller.ts:160](../../src/controllers/guild.controller.ts#L160))는 **영원히 도달 불가**(죽은 코드). `updateDate`도 미갱신.
- **✅ 수정함**: where에 `eq(guild.isDeleted, false)` 추가 + `updateDate` 갱신. 이제 이미 삭제된 길드는 404 반환.

---

---

## 4. Replays

### #12 GET /api/replays/:guildId — ✅ 이상 없음
- [replay.controller.ts:35-59](../../src/controllers/replay.controller.ts#L35-L59)
- 구조분해 기본값 `{ page=1, limit=10 }`으로 받아 `X-Total-Pages`에 NaN 위험 없음(#8과 달리 안전). 에러는 `next(error)` 위임. 양호.

### #13 POST /api/replays — ✅ 이상 없음
- [replay.controller.ts:12-29](../../src/controllers/replay.controller.ts#L12-L29)
- 디스코드 봇 JSON 업로드. `facade.allSave` + `next(error)`. 권한은 부모 `restrictBotToLocalhost`+`verifyAuth`에 위임. 깔끔.

### #14 POST /api/replays/web — 🔵 점검 사항 다수 (코드 버그는 아님)
- [replay.controller.ts:65-136](../../src/controllers/replay.controller.ts#L65-L136) · [requireRole.ts:103-146](../../src/middlewares/requireRole.ts#L103-L146)
- 파일별 try/catch 부분성공 응답 설계 양호. 검증 순서(확장자→magic bytes→파싱→중복해시→저장) 정상. `requireUploadPermission`(allowAllUploads/ userUploader 분기, admin bypass) 정상.
- 🔵 **`verifyAuth` 중복**: 라우트에서 인라인 `verifyAuth`([replay.routes.ts:181](../../src/routes/replay.routes.ts#L181)) — 부모 라우터(index.ts:23)에서 이미 적용됨. 중복 호출(세션 재검증 1회 추가). 제거 가능하나 무해.
- 🔵 **failed.reason 문자열 불일치**: `invalid_extension`/`invalid_format`/`parse_failed`/`save_failed`는 snake_case인데 `'duplicated replay data'`만 공백 포함. 프론트 분기/i18n 위해 키 통일 권장(예: `duplicated`).
- 🔴→🔵 **(중요) 메모리-코드 불일치**: 프로젝트 메모리에는 "웹 업로드 실패 시 `upload_violation` 기록 + 하루 10건 초과 시 userNormal 강등 + 응답 `demoted` 필드"가 **구현 완료**로 적혀 있으나, **코드 전체에 `uploadViolation`/`violation`/`demote` 참조가 0건**. 응답도 `{ succeeded, failed }`만 반환(`demoted` 없음). `uploadViolation.service.ts` 파일도 없음.
  - → 해당 기능은 현재 브랜치(dev 계열)에 **미존재**. 별도 미머지 브랜치(TRC-171)에 있거나 보류된 것으로 추정. **메모리가 stale** → 사용자 확인 후 메모리 정정 필요.
- 🔵 **파일 크기 한도**: multer `fileSize: 50MB`([replay.routes.ts:15](../../src/routes/replay.routes.ts#L15)) = swagger 표기 일치. (메모리의 "25MB/개"는 stale)

---

---

## 5. Guild Member

### #15 POST /api/guildMember/sub-account — 🟡 권한 검증 누락 (수정함)
- [guildMember.routes.ts:103-125](../../src/routes/guildMember.routes.ts#L103-L125)
- 형제 쓰기 라우트(PUT `/status`, DELETE `/sub-account`)는 `requireGuildRole('guildManager')`를 거는데 부계정 **연결**(POST)만 누락 → 일반 유저도 임의 계정 연결 가능했음.
- **✅ 수정함**: `requireGuildRole('guildManager', { from: 'body', key: 'guildId' })` 추가. 봇 요청은 `req.isBot` bypass로 그대로 통과([requireRole.ts:62](../../src/middlewares/requireRole.ts#L62))하므로 디스코드 봇 호출엔 영향 없고, 사람(웹) 호출만 guildManager 요구.
- 🔵 (기존 추적) 연결 시 player_code UPDATE가 guildId 미스코프 → 다중 길드 참여 계정의 타 길드 전적까지 병합. 부캐-본캐 연결이 "길드별"인지 "전역"인지 결정 후 별도 수정 예정.

### #16 GET /api/guildMember/:guildId/members — ✅ 이상 없음
- [guildMember.controller.ts:65-106](../../src/controllers/guildMember.controller.ts#L65-L106)
- `Number(limit) || 50` + `limitNum`으로 X-Total-Pages 계산 → NaN 위험 없음(#8과 달리 올바른 패턴). 양호.

### #17 GET /api/guildMember/:guildId/sub-accounts — ✅ 이상 없음
- 부계정 없을 때 200 + 빈 배열. 정상.

### #18 GET /api/guildMember/:guildId/:riotName — 🔵 참고
- [guildMember.controller.ts:18-58](../../src/controllers/guildMember.controller.ts#L18-L58)
- 동작 정상. 라우트 순서상 `/:guildId/members`·`/:guildId/sub-accounts`가 먼저 선언돼, riotName이 우연히 `members`/`sub-accounts`인 멤버는 검색 불가(엣지). catch 일괄 500.

### #19 PUT /api/guildMember/status — ✅ 동작 정상 / 🔵
- guildManager 권한 정상. Zod enum으로 이미 검증된 status를 컨트롤러에서 한 번 더 체크(중복, 무해). `BusinessError` status 분기 처리 양호.

### #20 DELETE /api/guildMember/sub-account — 🔵 에러 처리 불일치
- [guildMember.controller.ts:240-278](../../src/controllers/guildMember.controller.ts#L240-L278)
- guildManager 권한 정상. not-found는 service가 null 반환 → 404 정상. 다만 catch가 일괄 500이라 `BusinessError`(상태코드)가 #19와 달리 뭉개짐 — 패턴 통일 권장. 연결 해제 시 player_code 미원복은 **의도된 동작**으로 확인됨.

---

---

## 6. Matches

### #21 GET /api/matches/:guildId/:riotName/games — 🟡 X-Total-Pages NaN (수정함)
- [matchParticipant.controller.ts:80](../../src/controllers/matchParticipant.controller.ts#L80)
- #8과 동일 패턴: `Number(limit) ?? 20`이 limit 미입력 시 NaN. **✅ 수정함**: `Number(limit) || 20`.
- 동명이인은 200 + 후보목록 반환 처리 양호.

### #22 GET /api/matches/:guildId/:riotName/dashboard — ✅ 이상 없음
- [matchParticipant.controller.ts:102-167](../../src/controllers/matchParticipant.controller.ts#L102-L167)
- 4개 쿼리 Promise.all 병렬. 페이지네이션 없음. 양호.

### #23 GET /api/matches/:guildId/:riotName/most-picks — 🟡 X-Total-Pages NaN (수정함)
- [matchParticipant.controller.ts:226](../../src/controllers/matchParticipant.controller.ts#L226)
- 동일 패턴. **✅ 수정함**: `Number(limit) || 10`.
- 🔵 (참고) 월별 필터 미지원 — season/position만. 기능 추가는 별건.

### #24 GET /api/matches/:guildId/games/:gameId — ✅ 이상 없음
- [matchParticipant.controller.ts:247-282](../../src/controllers/matchParticipant.controller.ts#L247-L282)
- 404 처리 정상.

### #25 DELETE /api/matches/:guildId/games/:gameId — 🟡 권한 검증 누락 (수정함)
- [matchParticipant.routes.ts:214-237](../../src/routes/matchParticipant.routes.ts#L214-L237)
- 파괴적 작업인데 권한 미들웨어 없이 인증만으로 호출 가능했음. **✅ 수정함**: `requireGuildRole('guildManager', { from: 'params', key: 'guildId' })` 추가(봇은 isBot bypass로 통과). `deleteMatch` 서비스는 custom_match·match_participant·mmr_participant_metric·replay 일괄 soft delete로 정합성 양호.

---

---

## 7. Statistics

### #26 GET /api/statistics/:guildId/users — 🟡 X-Total-Pages NaN (수정함)
- [statistics.controller.ts:43](../../src/controllers/statistics.controller.ts#L43)
- 동일 NaN 패턴. **✅ 수정함**: `Number(limit) || 50`. 서비스 기본값(50)과 헤더 일치하므로 그 외 정상.

### #27 GET /api/statistics/:guildId/champions — 🟡 NaN + 기본 limit 불일치 (수정함)
- [statistics.controller.ts:90-91](../../src/controllers/statistics.controller.ts#L90-L91)
- NaN 패턴 + **서비스 실제 기본 limit=20인데 헤더(X-Limit·X-Total-Pages)는 50으로 계산** → limit 미입력 시 데이터는 20개인데 헤더가 50이라 거짓 보고.
- **✅ 수정함**: `(limit ?? 20)` + `Number(limit) || 20`으로 서비스 기본값에 맞춤.
- 🔵 (참고) 서비스 구조분해 기본 limit=50([statistics.service.ts:189](../../src/services/statistics.service.ts#L189))은 컨트롤러가 항상 값을 넘겨 미사용(데드). 20으로 통일하면 더 명확.

### Statistics 서비스 공통 — ✅ 로직 견고 / 🔵 설계 참고
- [statistics.service.ts](../../src/services/statistics.service.ts)
- SQL 전부 drizzle 파라미터 바인딩(인젝션 안전), 본계정 병합 조인(isMain·status·isDeleted 필터) 정합, count 서브쿼리 정상. winRate 정렬 시 `STATS_MIN_GAME_COUNT` having 적용 합리적.
- 🔵 `datePreset='range'`는 `EXTRACT(MONTH FROM create_date)`만 사용 — **연도 무시**, season 조건과 결합해 "시즌 내 월 범위"로 동작. 시즌이 같은 월을 두 번 포함하면 구분 불가(설계 의존).
- 🔵 `buildSeasonCondition`이 항상 적용 → `datePreset='recent'`도 기본 시즌으로 제한됨(최근 1개월 ∩ 현재 시즌). 의도면 OK.
- 🔵 `gameResult` 비교가 한글 `'승'/'패'` 문자열 — match_participant 테이블 실제 저장값 기준(mmr 테이블의 정수 1/0과 다름). 데이터 정합 전제.

---

## 진행 현황
- 점검 완료: #1 ~ #27
- 다음: #28 H2H
- ⚠️ 별도 추적:
  - 메모리의 웹 업로드 위반/강등 기능 미구현 (메모리 정정 완료)
  - #15 부계정 연결 player_code UPDATE guildId 스코프 → 정책 결정 후 수정
- ⚠️ 별도 추적:
  - 메모리의 웹 업로드 위반/강등 기능 미구현 (메모리 정정 완료)
  - #15 부계정 연결 player_code UPDATE guildId 스코프 → 정책 결정 후 수정
- ⚠️ 별도 추적:
  - 메모리의 웹 업로드 위반/강등 기능이 코드에 없음 → 메모리 정정 완료, 구현 여부는 미정
  - #15 부계정 연결 player_code UPDATE guildId 스코프 → 정책(길드별/전역) 결정 후 수정
