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

const buildLegacyBuffer = (): Buffer => {
  const buf = Buffer.alloc(600);
  buf.write('RIOT', 0, 'ascii');
  buf.writeUInt16LE(HEADER_LENGTH, 262);
  buf.writeUInt32LE(buf.length, 264);
  return buf;
};

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
    const buf = buildLegacyBuffer();
    buf.writeUInt16LE(0, 262);
    await expect(service.parseReplayData(buf)).rejects.not.toMatchObject({
      type: 'unsupported-replay-version',
    });
  });
});
