import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { User, type IUser } from '../../models/User.js';
import { extractBearer, verifyToken } from '../../services/auth.js';

export type AuthedUser = IUser;

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
  }
}

/** What an account without a verified email may still do (docs/API.md "Email gate"). */
const GATE_ALLOWED = new Set([
  'GET /api/v1/auth/me',
  'GET /api/v1/users/me',
  'POST /api/v1/users/me/email',
  'POST /api/v1/users/me/email/verify',
  'PATCH /api/v1/users/me/password',
  'POST /api/v1/auth/oauth/github/link',
  'DELETE /api/v1/users/me/oauth/github',
]);

export function hasVerifiedEmail(user: Pick<IUser, 'email' | 'emailVerifiedAt'>): boolean {
  return !!(user.email && user.emailVerifiedAt);
}

function gateAllows(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, '');
  return GATE_ALLOWED.has(`${req.method} ${path}`);
}

export function requireAuth(ctx: AppContext): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractBearer(req.headers.authorization);
    if (!token) throw ApiError.unauthorized('인증 토큰이 필요합니다.');
    const payload = verifyToken(ctx.config, token);
    const user = await User.findById(payload.sub).lean<IUser>().exec();
    if (!user) throw ApiError.unauthorized('사용자를 찾을 수 없습니다.');
    // signed out by a password reset/change or a temporary password
    if ((user.tokenVersion ?? 0) !== (payload.tv ?? 0)) throw ApiError.unauthorized('다시 로그인해 주세요.');
    // accounts without a verified email may only set one up (and manage their login methods)
    if (!hasVerifiedEmail(user) && !gateAllows(req)) throw ApiError.emailRequired();
    req.user = user;
    next();
  };
}

export function requireAdmin(): RequestHandler {
  return (req, _res, next) => {
    if (req.user?.role !== 'admin') throw ApiError.forbidden('관리자만 사용할 수 있습니다.');
    next();
  };
}

export function currentUser(req: Request): AuthedUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}
