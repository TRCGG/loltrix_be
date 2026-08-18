import { jest, describe, test, expect, afterEach } from '@jest/globals';

// 소스가 ESM 이라 jest.mock 호이스팅이 동작하지 않는다.
// unstable_mockModule 로 등록한 뒤 대상 모듈을 동적 import 해야 목이 적용된다.
jest.unstable_mockModule('../database/connectionPool.js', () => ({
  db: {},
}));
jest.unstable_mockModule('../services/systemConfig.service.js', () => ({
  systemConfigService: {
    getNumberConfig: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
    getConfigOrDefault: jest.fn(async (_key: unknown, defaultValue: unknown) => defaultValue),
  },
}));

const { ReplayService } = await import('../services/replay.service.js');
const { BusinessError } = await import('../types/error.js');

const service = new ReplayService();

const HEADER_LENGTH = 288;
const LEGACY_METADATA_LENGTH = 100;

const buildLegacyBuffer = (): Buffer => {
  const buf = Buffer.alloc(600);
  buf.write('RIOT', 0, 'ascii');
  buf.writeUInt16LE(HEADER_LENGTH, 262);
  buf.writeUInt32LE(buf.length, 264);
  buf.writeUInt32LE(HEADER_LENGTH, 268);
  buf.writeUInt32LE(LEGACY_METADATA_LENGTH, 272);
  buf.writeUInt32LE(HEADER_LENGTH + LEGACY_METADATA_LENGTH, 276);
  return buf;
};

const buildModernBuffer = (): Buffer => {
  const meta = Buffer.from(
    '{"gameLength":100,"gameVersion":"14.11.1.1","statsJson":"[{\\"WIN\\":\\"Win\\"}]"}',
    'utf-8',
  );
  const header = Buffer.alloc(HEADER_LENGTH);
  header.write('RIOT', 0, 'ascii');
  // 신형의 262-287은 서명 바이트 — 0이면 판별 조건이 저절로 안 맞아 오판 방어를
  // 검증하지 못하므로, 신형 리플 실측값을 그대로 넣는다
  header.writeUInt16LE(41162, 262);
  header.writeUInt32LE(1733317410, 264);
  header.writeUInt32LE(2860638707, 268);
  header.writeUInt32LE(1519455054, 272);
  header.writeUInt32LE(4009096142, 276);
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(meta.length, 0);
  return Buffer.concat([header, meta, tail]);
};

// private 판별 메서드를 직접 단언하기 위한 우회
const predicates = service as unknown as {
  isLegacyLayout(byte: Buffer): boolean;
  isLegacyHeader(header: Buffer): boolean;
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('구형 레이아웃 판별', () => {
  test('isLegacyLayout — 구형 true, 신형 false, 필드 하나만 맞으면 false', () => {
    expect(predicates.isLegacyLayout(buildLegacyBuffer())).toBe(true);
    expect(predicates.isLegacyLayout(buildModernBuffer())).toBe(false);

    const wrongHeaderLength = buildLegacyBuffer();
    wrongHeaderLength.writeUInt16LE(0, 262);
    expect(predicates.isLegacyLayout(wrongHeaderLength)).toBe(false);

    const wrongFileLength = buildLegacyBuffer();
    wrongFileLength.writeUInt32LE(1, 264);
    expect(predicates.isLegacyLayout(wrongFileLength)).toBe(false);
  });

  test('isLegacyHeader — 헤더 288바이트만으로 구형 true, 신형 false', () => {
    expect(predicates.isLegacyHeader(buildLegacyBuffer().subarray(0, HEADER_LENGTH))).toBe(true);
    expect(predicates.isLegacyHeader(buildModernBuffer().subarray(0, HEADER_LENGTH))).toBe(false);

    const inconsistent = buildLegacyBuffer().subarray(0, HEADER_LENGTH);
    inconsistent.writeUInt32LE(HEADER_LENGTH + LEGACY_METADATA_LENGTH + 1, 276);
    expect(predicates.isLegacyHeader(inconsistent)).toBe(false);
  });
});

describe('parseReplayData', () => {
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
});

describe('getRawData — Range 경로의 구형 조기 거절', () => {
  const stubDownload = (file: Buffer) =>
    jest
      .spyOn(
        ReplayService.prototype as unknown as { downloadDiscordFile: (...args: any[]) => any },
        'downloadDiscordFile',
      )
      .mockImplementation(async (_url: unknown, _limits: unknown, range?: any) => {
        if (range && 'start' in range) {
          return { buffer: file.subarray(range.start, range.end + 1), statusCode: 206 };
        }
        if (range && 'suffix' in range) {
          return { buffer: file.subarray(Math.max(0, file.length - range.suffix)), statusCode: 206 };
        }
        return { buffer: file, statusCode: 200 };
      });

  test('구형은 헤더 요청 한 번만으로 400을 내고 추가 다운로드가 없다', async () => {
    const spy = stubDownload(buildLegacyBuffer());

    await expect(
      service.getRawData({ fileUrl: 'https://cdn.example/legacy.rofl' } as any),
    ).rejects.toMatchObject({ status: 400, type: 'unsupported-replay-version' });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('신형은 Range 경로로 정상 파싱한다', async () => {
    stubDownload(buildModernBuffer());

    const { rawData } = await service.getRawData({
      fileUrl: 'https://cdn.example/modern.rofl',
    } as any);

    expect(rawData).toEqual([{ WIN: 'Win' }]);
  });
});
