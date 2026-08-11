/** @type {import('jest').Config} */
export default {
  // nanoid 5 가 ESM 전용이라 CJS 변환 모드로는 소스를 로드할 수 없다. ESM 프리셋 고정.
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/test/**/*.test.ts'],
  // 소스가 ESM 규약대로 상대 import 에 .js 를 붙이므로 해석 시 확장자를 떼어낸다.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
};
