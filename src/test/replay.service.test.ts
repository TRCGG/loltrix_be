import { jest, describe, test, expect } from '@jest/globals';

// 소스가 ESM 이라 jest.mock 호이스팅이 동작하지 않는다.
// unstable_mockModule 로 등록한 뒤 대상 모듈을 동적 import 해야 목이 적용된다.
jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: {},
}));

const { ReplayService } = await import('../services/replay.service.js');
const { BusinessError } = await import('../types/error.js');

const service = new ReplayService();

const HEADER_LENGTH = 288;

// 구형(~14.10) 파일: 헤더 오프셋 블록에 헤더 길이(@262)와 파일 전체 길이(@264)가 들어 있다
const buildLegacyBuffer = (): Buffer => {
  const buf = Buffer.alloc(600);
  buf.write('RIOT', 0, 'ascii');
  buf.writeUInt16LE(HEADER_LENGTH, 262);
  buf.writeUInt32LE(buf.length, 264);
  return buf;
};

// 신형(14.11+) 파일: 메타데이터가 파일 끝, 마지막 4바이트가 메타데이터 길이
const buildModernBuffer = (): Buffer => {
  const meta = Buffer.from(
    '{"gameLength":100,"gameVersion":"14.11.1.1","statsJson":"[{\\"WIN\\":\\"Win\\"}]"}',
    'utf-8',
  );
  const header = Buffer.alloc(HEADER_LENGTH);
  header.write('RIOT', 0, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(meta.length, 0);
  return Buffer.concat([header, meta, tail]);
};

describe('parseReplayData 구형 레이아웃 판별', () => {
  test('구형 파일은 unsupported-replay-version 400으로 거절한다', async () => {
    await expect(service.parseReplayData(buildLegacyBuffer())).rejects.toMatchObject({
      name: 'BusinessError',
      status: 400,
      type: 'unsupported-replay-version',
    });
    await expect(service.parseReplayData(buildLegacyBuffer())).rejects.toBeInstanceOf(
      BusinessError,
    );
  });

  test('신형 파일은 정상 파싱한다', async () => {
    const { stats } = await service.parseReplayData(buildModernBuffer());
    expect(stats).toEqual([{ WIN: 'Win' }]);
  });

  test('두 필드 중 하나만 맞으면 구형으로 판별하지 않는다', async () => {
    // 파일 길이 필드만 일치 (@262가 288이 아님) — 신형 경로로 진행돼 파싱 실패는 500
    const buf = buildLegacyBuffer();
    buf.writeUInt16LE(0, 262);
    await expect(service.parseReplayData(buf)).rejects.not.toMatchObject({
      type: 'unsupported-replay-version',
    });
  });
});
