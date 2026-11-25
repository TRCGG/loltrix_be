import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const createPresignedPost =
  jest.fn<(client: unknown, input: Record<string, unknown>) => Promise<unknown>>();
const send = jest.fn<(command: { input: Record<string, unknown> }) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost }));
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send })),
  PutObjectTaggingCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const { ImageUploadService, extractImageKeys } = await import('../services/imageUpload.service.js');
const { IMAGE_UPLOAD_MAX_BYTES, ImageConfirmError } = await import('../types/imageUpload.js');

const ENV_KEYS = ['S3_BUCKET', 'S3_KEY_PREFIX', 'IMAGE_PUBLIC_BASE_URL'] as const;
const saved: Record<string, string | undefined> = {};

const UUID = '3f2a9c1e-7b4d-4e8a-9f10-1a2b3c4d5e6f';
const UUID2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const imageUrl = (prefix: string, uuid = UUID, ext = 'webp') =>
  `https://img.gmok.kr/${prefix}/board/2026/11/${uuid}.${ext}`;

let service: InstanceType<typeof ImageUploadService>;

beforeEach(() => {
  ENV_KEYS.forEach((key) => {
    saved[key] = process.env[key];
  });
  process.env.S3_BUCKET = 'gmok-bucket';
  process.env.S3_KEY_PREFIX = 'dev';
  process.env.IMAGE_PUBLIC_BASE_URL = 'https://img.gmok.kr/';
  createPresignedPost
    .mockReset()
    .mockResolvedValue({ url: 'https://s3.example/', fields: { key: 'k' } });
  send.mockReset().mockResolvedValue({});
  service = new ImageUploadService();
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
});

describe('업로드 허가 발급', () => {
  test('서버가 경로를 정하고 크기·형식·캐시·태그를 서명 조건에 넣는다', async () => {
    const ticket = await service.createUploadTicket('image/png', new Date('2026-01-31T23:59:00Z'));

    const [, input] = createPresignedPost.mock.calls[0];
    expect(input.Bucket).toBe('gmok-bucket');
    expect(input.Key).toMatch(/^dev\/board\/2026\/01\/[0-9a-f-]{36}\.png$/);
    expect(input.Conditions).toEqual([['content-length-range', 1, IMAGE_UPLOAD_MAX_BYTES]]);
    expect(input.Fields).toEqual({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      tagging:
        '<Tagging><TagSet><Tag><Key>status</Key><Value>pending</Value></Tag></TagSet></Tagging>',
    });
    expect(input.Expires).toBe(300);
    // 끝의 /는 떼고 붙인다
    expect(ticket.publicUrl).toBe(`https://img.gmok.kr/${input.Key}`);
    expect(ticket).toMatchObject({ url: 'https://s3.example/', fields: { key: 'k' } });
  });

  test('jpeg는 jpg 확장자로 저장한다', async () => {
    await service.createUploadTicket('image/jpeg');
    expect(createPresignedPost.mock.calls[0][1].Key).toMatch(/\.jpg$/);
  });

  test('S3_KEY_PREFIX 앞뒤의 /는 떼고 쓴다', async () => {
    process.env.S3_KEY_PREFIX = '/dev/';
    await service.createUploadTicket('image/webp');
    expect(createPresignedPost.mock.calls[0][1].Key).toMatch(/^dev\/board\//);
  });

  test('설정이 하나라도 없으면 503', async () => {
    delete process.env.S3_KEY_PREFIX;
    await expect(service.createUploadTicket('image/webp')).rejects.toMatchObject({ status: 503 });
    expect(createPresignedPost).not.toHaveBeenCalled();
  });
});

describe('본문 이미지 키 추출', () => {
  test('이 서버 접두사의 업로드 이미지만, 중복 없이', () => {
    const content = [
      `![a](${imageUrl('dev')})`,
      `![a again](${imageUrl('dev')})`,
      `![b](${imageUrl('dev', UUID2, 'jpg')})`,
      `![prod](${imageUrl('prod')})`,
      '![external](https://live.lol-auction.workers.dev/guide/a.png)',
      `![other path](https://img.gmok.kr/dev/other/2026/11/${UUID}.webp)`,
    ].join('\n');

    const config = { keyPrefix: 'dev', publicBaseUrl: 'https://img.gmok.kr' };
    expect(extractImageKeys(content, config)).toEqual([
      `dev/board/2026/11/${UUID}.webp`,
      `dev/board/2026/11/${UUID2}.jpg`,
    ]);
  });

  test('쿼리스트링·HTML 속성 뒤에 붙은 주소도 키만 뽑는다', () => {
    const content = `![a](${imageUrl('dev')}?v=1) <img src="${imageUrl('dev', UUID2)}">`;
    expect(
      extractImageKeys(content, { keyPrefix: 'dev', publicBaseUrl: 'https://img.gmok.kr' }),
    ).toEqual([`dev/board/2026/11/${UUID}.webp`, `dev/board/2026/11/${UUID2}.webp`]);
  });

  test('도메인의 .을 아무 글자로 보지 않고, 확장자가 이어지면 다른 파일로 본다', () => {
    const content = [
      `![x](https://imgXgmokXkr/dev/board/2026/11/${UUID}.webp)`,
      `![y](${imageUrl('dev', UUID, 'pngx')})`,
      `![z](${imageUrl('dev', UUID, 'png.bak')})`,
    ].join('\n');
    expect(
      extractImageKeys(content, { keyPrefix: 'dev', publicBaseUrl: 'https://img.gmok.kr' }),
    ).toEqual([]);
  });
});

describe('저장 시 이미지 확정', () => {
  test('본문의 이미지마다 status=used 태그로 바꾼다', async () => {
    await service.confirmImages(`![a](${imageUrl('dev')}) ![b](${imageUrl('dev', UUID2)})`);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([command]) => command.input)).toEqual([
      {
        Bucket: 'gmok-bucket',
        Key: `dev/board/2026/11/${UUID}.webp`,
        Tagging: { TagSet: [{ Key: 'status', Value: 'used' }] },
      },
      {
        Bucket: 'gmok-bucket',
        Key: `dev/board/2026/11/${UUID2}.webp`,
        Tagging: { TagSet: [{ Key: 'status', Value: 'used' }] },
      },
    ]);
  });

  test('업로드 이미지가 없거나 설정이 없으면 S3를 부르지 않는다', async () => {
    await service.confirmImages('![ext](https://example.com/a.png) 본문만');
    delete process.env.S3_BUCKET;
    await service.confirmImages(`![a](${imageUrl('dev')})`);
    expect(send).not.toHaveBeenCalled();
  });

  test('수명 주기로 이미 지워진 이미지는 400으로 알린다', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('gone'), { name: 'NoSuchKey' }));

    const error = await service.confirmImages(`![a](${imageUrl('dev')})`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImageConfirmError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as Error).message).toContain(`dev/board/2026/11/${UUID}.webp`);
  });

  test('그 밖의 S3 실패는 502로 다시 저장하게 한다', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    const error = await service
      .confirmImages(`![a](${imageUrl('dev')}) ![b](${imageUrl('dev', UUID2)})`)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImageConfirmError);
    expect(error).toMatchObject({ status: 502 });
    // 실패한 키만 알려 다시 붙여넣을 이미지를 찾게 한다
    expect((error as Error).message).toContain(`dev/board/2026/11/${UUID2}.webp`);
    expect((error as Error).message).not.toContain(`dev/board/2026/11/${UUID}.webp`);
  });
});
