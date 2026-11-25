import { BusinessError } from './error.js';

/** 업로드를 허가하는 형식과 저장 확장자. GIF는 받지 않고, SVG는 스크립트가 실행될 수 있어 받지 않는다. */
export const IMAGE_CONTENT_TYPES = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
} as const;

export type ImageContentType = keyof typeof IMAGE_CONTENT_TYPES;

export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export interface ImageUploadTicket {
  /** 브라우저가 multipart/form-data로 POST할 S3 주소 */
  url: string;
  /** 파일보다 앞에 그대로 넣어야 하는 폼 필드 */
  fields: Record<string, string>;
  /** 업로드가 끝난 뒤 본문에 넣을 이미지 주소 */
  publicUrl: string;
}

/**
 * 게시글 작성·수정이 이 오류로 실패하면 컨트롤러가 그대로 응답한다.
 * 태그를 못 바꾼 채 글이 저장되면 이미지가 1~2일 뒤 수명 주기 규칙에 지워지기 때문이다.
 */
export class ImageConfirmError extends BusinessError {
  constructor(message: string, status: number) {
    super(message, status, { type: 'image-confirm-failed', showMessage: true });
    this.name = 'ImageConfirmError';
    // BusinessError 생성자가 프로토타입을 BusinessError로 고정해서, 다시 잡지 않으면 instanceof가 안 맞는다.
    Object.setPrototypeOf(this, ImageConfirmError.prototype);
  }
}
