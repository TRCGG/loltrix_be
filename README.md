# loltrix_be

내전 검색 서비스 백엔드 (League of Legends Custom Game Records Search Service - Backend)

## 기술 스택 (Tech Stack)

- [TypeScript](https://www.typescriptlang.org/) - 정적 타입 지원을 위한 JavaScript 슈퍼셋
- [Express.js](https://expressjs.com/) - 웹 애플리케이션 프레임워크
- [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM for PostgreSQL
- [PostgreSQL](https://www.postgresql.org/) - 관계형 데이터베이스
- [Zod](https://zod.dev/) - TypeScript 기반 스키마 검증 라이브러리
- [ESLint](https://eslint.org/) - 코드 린팅 도구
- [Prettier](https://prettier.io/) - 코드 포맷팅 도구
- [pnpm](https://pnpm.io/) - 빠르고 디스크 효율적인 패키지 매니저

## 프로젝트 구조 (Project Structure)

```
loltrix_be/
├── src/                      # 소스 코드
│   ├── controllers/          # 컨트롤러 (비즈니스 로직)
│   ├── middlewares/          # 미들웨어 (에러 처리, 검증)
│   ├── routes/               # Express 라우트 정의
│   ├── database/             # 데이터베이스 연결 및 ORM 설정
│   ├── types/                # TypeScript 타입 정의
│   ├── utils/                # 유틸리티 함수
│   ├── loltrix/              # 정적 파일 (프론트엔드)
│   ├── init.ts               # 데이터베이스 초기화
│   └── index.ts              # 애플리케이션 진입점
├── drizzle/                  # Drizzle ORM 설정 및 마이그레이션
├── .env.development          # 개발 환경 변수

├── .env.production           # 프로덕션 환경 변수
├── .eslintrc.js              # ESLint 설정
├── .prettierrc               # Prettier 설정
├── package.json              # 프로젝트 메타데이터 및 의존성
├── tsconfig.json             # TypeScript 설정
└── README.md                 # 프로젝트 문서
```

## 설치 방법 (Installation)

### 전제 조건 (Prerequisites)

- Node.js (v18 이상)
- pnpm (v8 이상)
- PostgreSQL 데이터베이스

### 설치 단계 (Installation Steps)

1. 저장소 클론

```bash
git clone https://github.com/TRCGG/loltrix_be.git
cd loltrix_be
```

2. 의존성 설치

```bash
pnpm install
```

3. 환경 변수 설정

`.env.example` 파일을 참고하여 `.env.development` 또는 `.env.production` 파일을 생성하고 필요한 환경 변수를 설정합니다.

필수 환경 변수:
- `DB_URL` - PostgreSQL 데이터베이스 연결 URL
- `COOKIE_SECRET` - 세션 쿠키 암호화 키
- 기타 데이터베이스 연결 설정

4. 개발 서버 실행

```bash
pnpm dev
```

서버는 기본적으로 http://localhost:3000 에서 실행되며, 시작 시 데이터베이스 연결을 자동으로 테스트합니다.

## 사용 가능한 스크립트 (Available Scripts)

- `pnpm dev` - ts-node를 사용한 개발 서버 실행
- `pnpm build` - TypeScript를 JavaScript로 컴파일 (`dist/` 디렉토리)
- `pnpm start` - 컴파일된 코드로 프로덕션 서버 실행
- `pnpm lint` - TypeScript 파일에 ESLint 실행
- `pnpm lint:fix` - ESLint 실행 및 자동 수정
- `pnpm format` - Prettier를 사용하여 코드 포맷팅

## 아키텍처 (Architecture)

### 백엔드 구조
- **Express.js** 서버 with TypeScript
- **Drizzle ORM** with PostgreSQL 데이터베이스 연결
- **Zod**를 사용한 요청 검증
- ESModules 사용 (`package.json`에 `"type": "module"` 설정)

### 데이터베이스
- PostgreSQL with 연결 풀링 (최대 20개 연결)
- Drizzle ORM이 `src/database/connectionPool.ts:23`에서 초기화
- 서버 시작 시 `src/init.ts:4`에서 데이터베이스 연결 테스트 실행
- `DB_URL` 환경 변수 필요

### 주요 미들웨어 스택
- morgan (HTTP 로깅)
- helmet (보안 헤더)
- cors (교차 출처)
- compression (gzip)
- express-session with 쿠키 파싱
- `src/loltrix/` 디렉토리에서 정적 파일 서빙

### 환경 설정
환경별 설정 파일:
- `.env.development` - 개발 환경
- `.env.production` - 프로덕션 환경
- `.env.example` - 모든 변수가 포함된 템플릿 파일

`NODE_ENV`에 따라 올바른 .env 파일을 자동으로 로드합니다.

필수 변수: `DB_URL`, `COOKIE_SECRET`, 데이터베이스 연결 세부사항  
프로덕션 SSL 설정은 `DB_SSL` 및 `DB_SSL_REJECT_UNAUTHORIZED`로 구성 가능

### 에러 처리
- `src/middlewares/errorHandler.ts`의 커스텀 에러 핸들러 미들웨어
- `src/middlewares/notFoundHandler.ts`의 404 핸들러
- 시작 시 데이터베이스 연결 검증

애플리케이션은 API 엔드포인트(`/api/*`)와 정적 프론트엔드 파일을 모두 제공하며, 루트 라우트에서 `src/loltrix/index.html`을 제공합니다.

## 라이센스 (License)

MIT License
