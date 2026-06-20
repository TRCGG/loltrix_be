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

## 진행 현황
- 점검 완료: #1 ~ #6
- 다음: #7 Guilds
