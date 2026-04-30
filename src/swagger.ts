import swaggerAutogen from 'swagger-autogen';

const options = {
  openapi: '3.0.0',
  language: 'ko',
};

const generator = swaggerAutogen(options);

const doc = {
  info: {
    title: 'Gmok API',
    description: 'API 명세서',
    version: '1.0.0',
  },
  servers: [
    {
      url: 'http://localhost:19901',
      description: 'Local Server',
    },
    {
      url: 'https://dev-api.gmok.kr',
      description: 'Dev Server',
    },
  ],
  components: {
    securitySchemes: {
      // 1. 세션 쿠키 인증 (유저용)
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'session_uid',
        description: '로그인 후 발급되는 세션 쿠키',
      },
      // 2. 봇 헤더 인증 (봇/관리자용)
      botAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-discord-bot',
        description: '디스코드 봇 인증',
      },
    },
  },
  // 기본적으로 모든 API에 이 두 가지 인증 중 하나가 필요하다고 표시
  security: [{ cookieAuth: [] }, { botAuth: [] }],
  tags: [
    { name: 'Health', description: '서버 상태 확인' },
    { name: 'Auth', description: '인증 관련' },
    { name: 'Guild', description: '길드 관리' },
    { name: 'GuildMember', description: '길드 멤버 관리' },
    { name: 'Matches', description: '전적 및 매치 데이터' },
    { name: 'Replays', description: '리플레이 관리' },
    { name: 'Statistics', description: '통계' },
  ],
};

const outputFile = './src/swagger-output.json';
const endpointsFiles = ['./src/index.ts'];

generator(outputFile, endpointsFiles, doc);
