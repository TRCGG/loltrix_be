import { randomUUID } from 'node:crypto';
import { PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { BusinessError } from '../types/error.js';
import {
  IMAGE_CONTENT_TYPES,
  IMAGE_UPLOAD_MAX_BYTES,
  ImageConfirmError,
  ImageContentType,
  ImageUploadTicket,
} from '../types/imageUpload.js';

const UPLOAD_EXPIRES_SECONDS = 5 * 60;
// 경로가 uuid라 같은 주소의 내용이 바뀌지 않는다.
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// 이 태그 값은 S3 수명 주기 규칙(status=pending → 1일 뒤 삭제)과 짝이다. 바꾸면 규칙도 같이 바꿔야 한다.
const tagging = (status: 'pending' | 'used') =>
  `<Tagging><TagSet><Tag><Key>status</Key><Value>${status}</Value></Tag></TagSet></Tagging>`;

interface ImageStorageConfig {
  bucket: string;
  keyPrefix: string;
  publicBaseUrl: string;
}

const readConfig = (): ImageStorageConfig | null => {
  const bucket = process.env.S3_BUCKET;
  // 'dev/'처럼 넣으면 키가 'dev//board/…'가 되어 IAM 리소스(dev/board/*)에 걸리지 않는다.
  const keyPrefix = process.env.S3_KEY_PREFIX?.replace(/^\/+|\/+$/g, '');
  const publicBaseUrl = process.env.IMAGE_PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (!bucket || !keyPrefix || !publicBaseUrl) return null;
  return { bucket, keyPrefix, publicBaseUrl };
};

interface S3Failure {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @desc 본문에 들어 있는 이 서버 경로의 업로드 이미지 키 목록 (중복 제거)
 * 다른 환경(dev↔prod) 경로는 IAM 권한 밖이라 제외한다.
 */
export const extractImageKeys = (
  content: string,
  { keyPrefix, publicBaseUrl }: Pick<ImageStorageConfig, 'keyPrefix' | 'publicBaseUrl'>,
): string[] => {
  const extensions = Object.values(IMAGE_CONTENT_TYPES).join('|');
  const pattern = new RegExp(
    `${escapeRegExp(publicBaseUrl)}/(${escapeRegExp(keyPrefix)}/board/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.(?:${extensions}))(?![\\w.])`,
    'g',
  );
  return [...new Set(Array.from(content.matchAll(pattern), (m) => m[1]))];
};

/**
 * @desc 게시판 이미지 업로드 — S3 presigned POST 발급과 저장 확정(태그 변경)
 */
export class ImageUploadService {
  private client: S3Client | null = null;

  // 자격 증명은 SDK 기본 체인(AWS_ACCESS_KEY_ID·AWS_SECRET_ACCESS_KEY·AWS_REGION)에서 읽는다.
  private s3() {
    this.client ??= new S3Client({});
    return this.client;
  }

  /**
   * @desc 업로드 허가 발급. 크기·형식·경로·태그는 S3 정책 조건으로 강제한다
   * — 브라우저 압축은 API를 직접 부르면 건너뛸 수 있다.
   */
  public async createUploadTicket(
    contentType: ImageContentType,
    now = new Date(),
  ): Promise<ImageUploadTicket> {
    const config = readConfig();
    if (!config) {
      throw new BusinessError('Image upload is not configured', 503, { showMessage: true });
    }

    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const key = `${config.keyPrefix}/board/${year}/${month}/${randomUUID()}.${IMAGE_CONTENT_TYPES[contentType]}`;

    // Fields에 넣은 값은 라이브러리가 정확 일치 조건으로 서명에 넣는다.
    const { url, fields } = await createPresignedPost(this.s3(), {
      Bucket: config.bucket,
      Key: key,
      Conditions: [['content-length-range', 1, IMAGE_UPLOAD_MAX_BYTES]],
      Fields: {
        'Content-Type': contentType,
        'Cache-Control': CACHE_CONTROL,
        tagging: tagging('pending'),
      },
      Expires: UPLOAD_EXPIRES_SECONDS,
    });

    return { url, fields, publicUrl: `${config.publicBaseUrl}/${key}` };
  }

  /**
   * @desc 본문의 업로드 이미지를 status=used로 바꿔 수명 주기 삭제 대상에서 뺀다.
   * 설정이 없는 환경(로컬)에서는 아무것도 하지 않는다.
   */
  public async confirmImages(content: string): Promise<void> {
    const config = readConfig();
    if (!config) return;
    const keys = extractImageKeys(content, config);
    if (keys.length === 0) return;

    const results = await Promise.allSettled(
      keys.map((key) =>
        this.s3().send(
          new PutObjectTaggingCommand({
            Bucket: config.bucket,
            Key: key,
            Tagging: { TagSet: [{ Key: 'status', Value: 'used' }] },
          }),
        ),
      ),
    );

    const failed = results.flatMap((result, i) =>
      result.status === 'rejected' ? [{ key: keys[i], error: result.reason as S3Failure }] : [],
    );
    if (failed.length === 0) return;

    // 붙여넣고 하루 넘게 저장하지 않으면 수명 주기 규칙이 먼저 지운다.
    const expired = failed.filter(({ error }) => error?.name === 'NoSuchKey');
    if (expired.length > 0) {
      throw new ImageConfirmError(
        `Uploaded image expired. Paste it again: ${expired.map(({ key }) => key).join(', ')}`,
        400,
      );
    }
    console.error(
      '[imageUpload] 이미지 확정 실패',
      failed.map(({ key, error }) => ({
        key,
        name: error?.name,
        status: error?.$metadata?.httpStatusCode,
        message: error?.message,
      })),
    );
    // ListBucket 권한이 없으면 S3가 없는 객체를 404 대신 403으로 줄 수 있어, 그 경우에도
    // 어떤 이미지를 다시 붙여넣어야 하는지 알 수 있게 키를 함께 알린다.
    throw new ImageConfirmError(
      `Failed to confirm uploaded images. Try saving again, or paste these again: ${failed.map(({ key }) => key).join(', ')}`,
      502,
    );
  }
}

export const imageUploadService = new ImageUploadService();
