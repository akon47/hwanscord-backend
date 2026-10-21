export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'MAIL_DISABLED'
  | 'MAIL_QUOTA'
  | 'INTERNAL';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static validation(message: string, details?: unknown) {
    return new ApiError(400, 'VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = '인증이 필요합니다.') {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = '권한이 없습니다.') {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = '찾을 수 없습니다.') {
    return new ApiError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string) {
    return new ApiError(409, 'CONFLICT', message);
  }
  static payloadTooLarge(message = '파일이 너무 큽니다.') {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
  }
  static unsupportedMediaType(message = '지원하지 않는 파일 형식입니다.') {
    return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  }
  static rateLimited(message = '요청이 너무 많습니다. 잠시 후 다시 시도하세요.') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }
  static mailDisabled() {
    return new ApiError(503, 'MAIL_DISABLED', '메일 발송이 설정되어 있지 않습니다.');
  }
  static mailQuota() {
    return new ApiError(
      503,
      'MAIL_QUOTA',
      '오늘 보낼 수 있는 메일을 모두 사용했습니다. 내일 다시 시도해 주세요.',
    );
  }
  static internal(message = '서버 오류가 발생했습니다.') {
    return new ApiError(500, 'INTERNAL', message);
  }
}
