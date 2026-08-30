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

jest.unstable_mockModule('../services/competition.service.js', () => ({
  competitionService: {
    resolveForSave: jest.fn(async () => null),
  },
}));

const { ReplayService, attachmentAgeSeconds, stallStage } = await import(
  '../services/replay.service.js'
);
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
      .mockImplementation(
        async (_url: unknown, _limits: unknown, _logContext: unknown, range?: any) => {
          if (range && 'start' in range) {
            return { buffer: file.subarray(range.start, range.end + 1), statusCode: 206 };
          }
          if (range && 'suffix' in range) {
            return {
              buffer: file.subarray(Math.max(0, file.length - range.suffix)),
              statusCode: 206,
            };
          }
          return { buffer: file, statusCode: 200 };
        },
      );

  test('구형은 헤더 요청 한 번만으로 400을 내고 추가 다운로드가 없다', async () => {
    const spy = stubDownload(buildLegacyBuffer());

    await expect(
      service.getRawData({ fileUrl: 'https://cdn.example/legacy.rofl' } as any, 'test'),
    ).rejects.toMatchObject({ status: 400, type: 'unsupported-replay-version' });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('신형은 Range 경로로 정상 파싱한다', async () => {
    stubDownload(buildModernBuffer());

    const { rawData } = await service.getRawData(
      { fileUrl: 'https://cdn.example/modern.rofl' } as any,
      'test',
    );

    expect(rawData).toEqual([{ WIN: 'Win' }]);
  });
});

describe('attachmentAgeSeconds', () => {
  // 하위 22비트(워커·시퀀스)는 전부 1로 채운다 — 타임스탬프와 무관한 비트가 섞여도
  // 결과가 같아야 시프트 누락을 잡을 수 있다.
  const TIMESTAMP_SCALE = 2n ** 22n;
  const snowflakeAt = (ms: number): string =>
    ((BigInt(ms) - 1420070400000n) * TIMESTAMP_SCALE + (TIMESTAMP_SCALE - 1n)).toString();

  test('업로드 후 경과 초를 계산한다', () => {
    const uploadedAt = Date.parse('2026-08-23T00:00:00.000Z');
    const url = `https://cdn.discordapp.com/attachments/123456789012345678/${snowflakeAt(
      uploadedAt,
    )}/game.rofl?ex=abc&is=def&hm=ghi`;

    expect(attachmentAgeSeconds(url, uploadedAt + 90_000)).toBe(90);
  });

  test('53비트를 넘는 스노플레이크도 정밀도 손실 없이 계산한다', () => {
    const uploadedAt = Date.parse('2026-08-23T00:00:00.000Z');
    const id = snowflakeAt(uploadedAt);
    expect(Number(id) > Number.MAX_SAFE_INTEGER).toBe(true);
    expect(
      attachmentAgeSeconds(`https://cdn.discordapp.com/attachments/1/${id}/a.rofl`, uploadedAt),
    ).toBe(0);
  });

  test('첨부 URL이 아니거나 id를 못 뽑으면 null', () => {
    expect(attachmentAgeSeconds('web')).toBeNull();
    expect(attachmentAgeSeconds('https://cdn.example/legacy.rofl')).toBeNull();
    expect(
      attachmentAgeSeconds('https://cdn.discordapp.com/attachments/1/notanid/a.rofl'),
    ).toBeNull();
  });
});

describe('stallStage', () => {
  test('연결 전 / 헤더 전 / 본문 중 을 구분한다', () => {
    expect(stallStage({ connectedAt: null, respondedAt: null })).toBe('stall:connect');
    expect(stallStage({ connectedAt: 1, respondedAt: null })).toBe('stall:ttfb');
    expect(stallStage({ connectedAt: 1, respondedAt: 2 })).toBe('stall:body');
  });
});

describe('sanitizeFileName', () => {
  test('확장자 제거, 경로·쿼리 문자를 _로, 한글·영숫자·_.-는 보존', () => {
    expect(ReplayService.sanitizeFileName('내전 2024/08/23 #1?.rofl')).toBe('내전_2024_08_23_1');
    expect(ReplayService.sanitizeFileName('???.rofl')).toBe('replay');
    expect(ReplayService.sanitizeFileName('___.rofl')).toBe('replay');
  });

  test('NFD 파일명(macOS)의 결합 문자를 보존한다', () => {
    expect(ReplayService.sanitizeFileName('café.rofl')).toBe('café');
    expect(ReplayService.sanitizeFileName('한.rofl')).toBe('한');
    expect(ReplayService.sanitizeFileName('KR-123_final.v2.rofl')).toBe('KR-123_final.v2');
  });

  test('100자로 자른다', () => {
    expect(ReplayService.sanitizeFileName(`${'a'.repeat(150)}.rofl`)).toHaveLength(100);
  });
});

describe('generateReplayCode', () => {
  test('RPY-YYMMDD-파일명-시퀀스 형식이고 번호는 시퀀스에서 받는다', async () => {
    const execute = jest.fn(async () => ({ rows: [{ seq: '4321' }] }));
    const gen = (service as unknown as {
      generateReplayCode(fileName: string, executor: unknown): Promise<string>;
    }).generateReplayCode.bind(service);

    const code = await gen('game1', { execute });

    expect(code).toMatch(/^RPY-\d{6}-game1-4321$/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('replaySave — 동시 업로드 중복', () => {
  const buildTx = (insertError: unknown) => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    execute: async () => ({ rows: [{ seq: '1' }] }),
    insert: () => ({
      values: () => ({
        returning: async () => {
          throw insertError;
        },
      }),
    }),
  });

  const fileData = {
    fileName: 'game1.rofl',
    fileUrl: 'https://cdn/game1.rofl',
    createUser: 'user1',
    guildId: 'guild1',
  };

  const save = (tx: unknown) => service.replaySave(fileData, { any: 'raw' }, tx as never);

  test('유니크 인덱스 위반(23505)을 사전 검사와 같은 400으로 바꾼다', async () => {
    const tx = buildTx({ code: '23505', constraint: 'uq_replay_hash_guild_active' });

    await expect(save(tx)).rejects.toMatchObject({
      message: 'duplicated replay data',
      status: 400,
    });
    await expect(save(tx)).rejects.toBeInstanceOf(BusinessError);
  });

  test('drizzle이 cause로 감싼 경우도 동일하게 처리한다', async () => {
    const wrapped = Object.assign(new Error('insert failed'), {
      cause: { code: '23505', constraint: 'uq_replay_hash_guild_active' },
    });

    await expect(save(buildTx(wrapped))).rejects.toBeInstanceOf(BusinessError);
  });

  test('다른 에러는 그대로 던진다', async () => {
    const other = Object.assign(new Error('connection lost'), { code: '08006' });

    await expect(save(buildTx(other))).rejects.toBe(other);
  });
});
