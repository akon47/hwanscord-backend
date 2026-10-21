import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { EmailToken, type EmailTokenPurpose, type IEmailToken } from '../models/EmailToken.js';

export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  // signup/change are 6-digit codes issued by emailCodes.ts; only `reset` uses link tokens
  signup: 10 * 60 * 1000,
  change: 10 * 60 * 1000,
  reset: 30 * 60 * 1000,
};

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Creates a token, voiding the user's older unused tokens of the same purpose. Returns the raw token. */
export async function issueToken(
  userId: Types.ObjectId,
  purpose: EmailTokenPurpose,
  email: string,
): Promise<string> {
  const now = new Date();
  await EmailToken.updateMany({ userId, purpose, usedAt: null }, { $set: { usedAt: now } }).exec();
  const token = crypto.randomBytes(32).toString('base64url');
  await EmailToken.create({
    userId,
    purpose,
    email,
    hash: hashToken(token),
    expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[purpose]),
    usedAt: null,
  });
  return token;
}

/** Atomically marks a valid (unused, unexpired) token as used and returns it; null otherwise. */
export async function consumeToken(
  token: string,
  purposes: EmailTokenPurpose[],
): Promise<IEmailToken | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const now = new Date();
  return EmailToken.findOneAndUpdate(
    { hash: hashToken(token), purpose: { $in: purposes }, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { new: true },
  )
    .lean<IEmailToken>()
    .exec();
}

/** How many tokens of a purpose were issued for the user since `since`. */
export function countIssued(
  userId: Types.ObjectId,
  purpose: EmailTokenPurpose,
  since: Date,
): Promise<number> {
  return EmailToken.countDocuments({ userId, purpose, createdAt: { $gte: since } }).exec();
}
