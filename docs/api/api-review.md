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

## 진행 현황
- 점검 완료: #1 ~ #11
- 다음: #12 Replays
