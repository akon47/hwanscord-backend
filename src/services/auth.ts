import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { isObjectId } from '../lib/ids.js';

export interface TokenPayload {
  sub: string;
  username: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // bcryptjs understands the $2a$/$2b$ hashes produced by the v1 server's native bcrypt
  return bcrypt.compare(password, hash);
}

export function signToken(config: Config, payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(config: Config, token: string): TokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.jwtSecret);
  } catch {
    throw ApiError.unauthorized('토큰이 유효하지 않습니다.');
  }
  if (!decoded || typeof decoded !== 'object') throw ApiError.unauthorized('토큰이 유효하지 않습니다.');
  const { sub, username } = decoded as Record<string, unknown>;
  if (typeof sub !== 'string' || !isObjectId(sub)) throw ApiError.unauthorized('토큰이 유효하지 않습니다.');
  return { sub, username: typeof username === 'string' ? username : '' };
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
  // tolerate a bare token (v1 clients sent it without a scheme)
  if (!token && scheme && scheme.split('.').length === 3) return scheme;
  return null;
}
