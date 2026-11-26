// =============================================================
// PM2 ecosystem 설정 템플릿 (loltrix_be)
// 복사해서 사용: cp ecosystem.config.example.cjs ecosystem.config.dev.cjs
// 실제 값이 든 ecosystem.config.*.cjs는 절대 커밋하지 않는다 (.gitignore `ecosystem*` 적용,
// 이 템플릿만 예외). 시크릿은 여기 평문으로 두지 말고 가능하면 서버의 .env.* 로 관리.
// 환경변수 키 설명은 .env.example 참고.
// =============================================================

// API 앱과 MMR 배치 앱이 같은 DB를 쓰므로 한 곳에서 정의한다.
const DB_ENV = {
  DB_HOST: "your-db-host.example.com",
  DB_PORT: "5432",
  DB_NAME: "your_db_name",
  DB_USER: "your_db_user",
  DB_PASSWORD: "your_db_password",
  DB_SSL: "true",
  DB_SSL_REJECT_UNAUTHORIZED: false,
};

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
        ...DB_ENV,

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
    {
      // MMR 일일 배치: API와 분리된 상주 프로세스. 매일 12:00 KST(코드에 Asia/Seoul 고정)에 하루치를 계산한다.
      // 서버 시간대와 무관하다. 계산 여부는 system_config MMR_BATCH_ENABLED=1로 켠다.
      // 처음 켜기 전 한 번: node dist/jobs/mmrBatch.cli.js --seed=<전체 계산 컷오프 C>
      // 수동 실행: node dist/jobs/mmrBatch.cli.js --once
      // 처음 등록: pm2 start ecosystem.config.cjs --only gmok-mmr-batch (이후 배포의 pm2 reload가 함께 재시작한다)
      name: "gmok-mmr-batch",
      script: "./dist/jobs/mmrBatch.cli.js",
      autorestart: true,
      watch: false,
      out_file: "./logs/mmr-batch.out.log",
      error_file: "./logs/mmr-batch.error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "development",
        ...DB_ENV,
      },
    },
  ],
};
