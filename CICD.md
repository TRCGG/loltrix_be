# CI/CD 도입 계획

## 배경
현재 수동 배포 환경(pnpm build → AWS Lightsail EC2 → pm2)에서 CI/CD를 단계적으로 도입한다.

## 브랜치 전략

| 브랜치 | 역할 | 배포 대상 |
|--------|------|-----------|
| `feat/*` | 개별 기능 개발 | - |
| `staging` | 기능 종합 & 검증 | - |
| `dev` | 개발서버 배포 | 개발서버 |
| `main` | 운영서버 배포 | 운영서버 |

**플로우**: `feat/*` → PR → `staging` → PR → `dev` (개발서버) → PR → `main` (운영서버)

## 배포 환경
- AWS Lightsail EC2
- pm2로 프로세스 관리
- pnpm 패키지 매니저, Node 20

## Phase 1: CI (완료)
- `.github/workflows/ci.yaml` 생성됨
- 트리거: `dev`, `main` 브랜치로의 PR 시
- 단계: checkout → pnpm install → pnpm build

## Phase 2: CD (미완료)
- [ ] `staging` 브랜치 생성
- [ ] 배포 쉘 스크립트 확인 (현재 접속 환경 안돼서 보류)
- [ ] CD 워크플로우 추가 (`dev` 머지 시 → `pnpm swagger` → `pnpm build` → 개발서버 배포)
- [ ] CD 워크플로우 추가 (`main` 머지 시 → `pnpm swagger` → `pnpm build` → 운영서버 배포)
- [ ] CI 트리거에 `staging` 브랜치 추가 검토

## 참고사항
- Swagger 파일(`swagger-output.json`)은 git tracked 상태 유지하되, CD 배포 시 `pnpm swagger` 실행하여 최신 파일로 재생성 후 배포
- 테스트 스크립트 미설정 상태. 추후 추가 시 CI step에도 반영 필요
