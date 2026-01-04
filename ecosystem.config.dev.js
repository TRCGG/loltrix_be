module.exports = {
  apps: [
    {
      name: "gmok-dev",
      script: "./dist/index.js",
      watch: ".",
      autorestart: false,
      env: {
        Server_PORT: 19901,
        NODE_ENV: "development",
        DB_HOST:
          "ls-f69cd2b2ff40dea85b853495928fb3eea7b0ec6a.cne6yk6ywufn.ap-northeast-2.rds.amazonaws.com",
        DB_PORT: "5432",
        DB_NAME: "gtrix_dev_v2",
        DB_USER: "gtrix_user",
        DB_PASSWORD: "welcomeUser1!",
        DB_URL:
          "jdbc:postgresql://ls-f69cd2b2ff40dea85b853495928fb3eea7b0ec6a.cne6yk6ywufn.ap-northeast-2.rds.amazonaws.com:5432/gtrix_dev",
        COOKIE_SECRET: "cookieSecret",
        DB_SSL: "true",
        DB_SSL_REJECT_UNAUTHORIZED: false,
        LOL_SEASON: 2025,
        DISCORD_CLIENT_ID: "1270820430961442878",
        DISCORD_CLIENT_SECRET: "WojafCCVXZkXaDWbDZewmfc58FTcNlpL",
        DISCORD_REDIRECT_URI: "https://dev-api.gmok.kr/api/auth/callback",
        DISCORD_BOT_SECRET: "V29qYWZDQ1ZYWmtYYURXYkRaZXdtZmM1OEZUY05scEw=",
      },
    },
  ],
};
