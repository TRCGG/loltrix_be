export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, unknown>[];
}

/**
 * 비즈니스 에러 타입
 * - DB에는 저장하되, 클라이언트에는 에러 메시지를 노출해야 하는 에러
 */
export class BusinessError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly title: string;
  public readonly isLoggable: boolean;
  public readonly showMessage: boolean;

  constructor(
    message: string,
    status: number = 400,
    options?: {
      type?: string;
      title?: string;
      isLoggable?: boolean;
      showMessage?: boolean;
    }
  ) {
    super(message);
    this.name = 'BusinessError';
    this.status = status;
    this.type = options?.type || 'business-error';
    this.title = options?.title || 'Business Error';
    this.isLoggable = options?.isLoggable ?? true; // 기본적으로 DB에 로깅
    this.showMessage = options?.showMessage ?? true; // 기본적으로 메시지 노출

    // Error 클래스 상속 시 프로토타입 체인 유지
    Object.setPrototypeOf(this, BusinessError.prototype);
  }
}

/**
 * 시스템 에러 타입
 * - DB에 저장하고, 클라이언트에는 에러코드만 노출
 */
export class SystemError extends Error {
  public readonly status: number;
  public readonly type: string;
  public readonly title: string;
  public readonly isLoggable: boolean;
  public readonly showMessage: boolean;

  constructor(
    message: string,
    status: number = 500,
    options?: {
      type?: string;
      title?: string;
      isLoggable?: boolean;
    }
  ) {
    super(message);
    this.name = 'SystemError';
    this.status = status;
    this.type = options?.type || 'system-error';
    this.title = options?.title || 'Internal Server Error';
    this.isLoggable = options?.isLoggable ?? true;
    this.showMessage = false; // 시스템 에러는 메시지 노출 안 함

    Object.setPrototypeOf(this, SystemError.prototype);
  }
}
