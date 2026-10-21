import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import { ZodError } from 'zod';
import type { Logger } from '../../logger.js';
import { ApiError } from '../../lib/errors.js';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json(ApiError.notFound('존재하지 않는 경로입니다.').toBody());
};

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    const apiError = toApiError(err);
    if (apiError.status >= 500) {
      logger.error({ err }, 'unhandled error');
    }
    if (apiError.status === 429 && typeof (err as { retryAfter?: number }).retryAfter === 'number') {
      res.setHeader('Retry-After', String((err as { retryAfter: number }).retryAfter));
    }
    res.status(apiError.status).json(apiError.toBody());
  };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of err.issues) {
      (fieldErrors[issue.path.join('.') || 'body'] ??= []).push(issue.message);
    }
    return ApiError.validation('입력값이 올바르지 않습니다.', { fieldErrors });
  }
  if (err instanceof MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return ApiError.payloadTooLarge();
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return ApiError.badRequest('잘못된 업로드 필드입니다.');
    return ApiError.badRequest(err.message);
  }
  const anyErr = err as { name?: string; code?: number; type?: string; status?: number; statusCode?: number };
  if (anyErr?.code === 11000) return ApiError.conflict('이미 존재하는 값입니다.');
  if (anyErr?.name === 'CastError') return ApiError.badRequest('잘못된 식별자입니다.');
  if (anyErr?.type === 'entity.parse.failed') return ApiError.badRequest('JSON 본문을 해석할 수 없습니다.');
  if (anyErr?.type === 'entity.too.large') return ApiError.payloadTooLarge('요청 본문이 너무 큽니다.');
  const status = anyErr?.status ?? anyErr?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new ApiError(
      status,
      status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST',
      (err as Error).message || 'Bad request',
    );
  }
  return ApiError.internal();
}
