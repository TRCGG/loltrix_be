// =============================================================
// PM2 ecosystem 설정 템플릿 (loltrix_be)
// 복사해서 사용: cp ecosystem.config.example.cjs ecosystem.config.dev.cjs
// 실제 값이 든 ecosystem.config.*.cjs는 절대 커밋하지 않는다 (.gitignore `ecosystem*` 적용,
// 이 템플릿만 예외). 시크릿은 여기 평문으로 두지 말고 가능하면 서버의 .env.* 로 관리.
// 환경변수 키 설명은 .env.example 참고.
// =============================================================
module.exports = {
  apps: [
    {
      name: "gmok-dev",
      script: "./dist/index.js",
      watch: ".",
      autorestart: false,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        PORT: 19901,
        NODE_ENV: "development",

        // --- Database (PostgreSQL) ---
        DB_HOST: "your-db-host.example.com",
        DB_PORT: "5432",
        DB_NAME: "your_db_name",
        DB_USER: "your_db_user",
        DB_PASSWORD: "your_db_password",
        DB_SSL: "true",
        DB_SSL_REJECT_UNAUTHORIZED: false,

        // --- Security ---
        COOKIE_SECRET: "change-me-random-string",

        // --- LoL ---
        LOL_SEASON: 2026,

        // --- Discord OAuth / 봇 검증 ---
        DISCORD_CLIENT_ID: "your_discord_client_id",
        DISCORD_CLIENT_SECRET: "your_discord_client_secret",
        DISCORD_REDIRECT_URI: "https://dev-api.gmok.kr/api/auth/callback",
        DISCORD_BOT_SECRET: "change-me-shared-with-bot",

        // --- Riot Tournament API (TRC-225 토너먼트코드 MVP) ---
        // dev 키는 24h 만료 → 재발급 시 provider 재등록 필요(forceReregister)
        RIOT_API_KEY: "RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        // dev 키 MVP 단계는 항상 true. 프로덕션 키 승인 후에만 false.
        RIOT_TOURNAMENT_STUB: "true",
        // 추측 불가능한 랜덤 문자열 (예: openssl rand -hex 32). 유출 시 즉시 교체.
        RIOT_CALLBACK_SECRET: "change-me-openssl-rand-hex-32",
        // 시크릿 경로까지 포함한 공개 콜백 URL (provider 등록 시 사용)
        RIOT_CALLBACK_URL: "https://dev-api.gmok.kr/api/callback/riot/change-me-openssl-rand-hex-32",

        // --- 봇 콜백 (TRC-226) — 미설정 시 http://127.0.0.1:19902 ---
        BOT_CALLBACK_URL: "http://127.0.0.1:19902",
      },
    },
  ],
};
