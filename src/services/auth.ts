import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Config } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { isObjectId } from '../lib/ids.js';

export interface TokenPayload {
  sub: string;
  username: string;
  /** the user's tokenVersion when issued; tokens without it count as 0 */
  tv?: number;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  // bcryptjs understands the $2a$/$2b$ hashes produced by the v1 server's native bcrypt
  return bcrypt.compare(password, hash);
}

/** Session token for a user (carries the current tokenVersion as `tv`). */
export function sessionToken(
  config: Config,
  user: { _id: { toHexString(): string }; username: string; tokenVersion?: number },
): string {
  return signToken(config, {
    sub: user._id.toHexString(),
    username: user.username,
    tv: user.tokenVersion ?? 0,
  });
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
  const { sub, username, purpose } = decoded as Record<string, unknown>;
  // OAuth state / pending-signup tokens are signed with the same secret but are never sessions
  if (purpose !== undefined) throw ApiError.unauthorized('토큰이 유효하지 않습니다.');
  if (typeof sub !== 'string' || !isObjectId(sub)) throw ApiError.unauthorized('토큰이 유효하지 않습니다.');
  const tv = (decoded as Record<string, unknown>).tv;
  return { sub, username: typeof username === 'string' ? username : '', tv: typeof tv === 'number' ? tv : 0 };
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() === 'bearer' && token) return token.trim();
  // tolerate a bare token (v1 clients sent it without a scheme)
  if (!token && scheme && scheme.split('.').length === 3) return scheme;
  return null;
}
