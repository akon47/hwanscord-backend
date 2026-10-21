import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '../../lib/errors.js';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** validated + transformed inputs (express 5 makes req.query read-only) */
    valid: { body: unknown; query: unknown; params: unknown };
  }
}

export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const fieldErrors: Record<string, string[]> = {};
    const out: { body: unknown; query: unknown; params: unknown } = {
      body: req.body,
      query: req.query,
      params: req.params,
    };
    for (const key of ['params', 'query', 'body'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (result.success) {
        out[key] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const field = issue.path.length ? issue.path.join('.') : key;
          (fieldErrors[field] ??= []).push(issue.message);
        }
      }
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw ApiError.validation('입력값이 올바르지 않습니다.', { fieldErrors });
    }
    req.valid = out;
    next();
  };
}

export function body<T extends ZodTypeAny>(req: { valid: { body: unknown } }, _schema: T): z.infer<T> {
  return req.valid.body as z.infer<T>;
}

export function query<T extends ZodTypeAny>(req: { valid: { query: unknown } }, _schema: T): z.infer<T> {
  return req.valid.query as z.infer<T>;
}

export function params<T extends ZodTypeAny>(req: { valid: { params: unknown } }, _schema: T): z.infer<T> {
  return req.valid.params as z.infer<T>;
}
