import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { EmailToken, type IEmailToken } from '../models/EmailToken.js';

export type CodePurpose = 'signup' | 'change';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_MAX_ATTEMPTS = 5;

/** Who a code belongs to: an address for signup (no account yet), an account for email change. */
export type CodeOwner = { purpose: 'signup'; email: string } | { purpose: 'change'; userId: Types.ObjectId };

function ownerFilter(owner: CodeOwner) {
  return owner.purpose === 'signup'
    ? { purpose: 'signup' as const, email: owner.email }
    : { purpose: 'change' as const, userId: owner.userId };
}

/** HMAC bound to purpose, address and token id: a stolen hash is useless and equal codes never collide. */
export function codeHash(
  secret: string,
  purpose: CodePurpose,
  email: string,
  code: string,
  id: Types.ObjectId,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${purpose}|${email}|${code}|${id.toHexString()}`)
    .digest('hex');
}

export function randomCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * Issues a fresh code for `email` and voids the owner's previous unused codes.
 * `deliverable: false` records an attempt that can never be redeemed (used for addresses that already have an
 * account, so the endpoint behaves identically and the per-address throttle still applies).
 */
export async function issueCode(
  secret: string,
  owner: CodeOwner,
  email: string,
  options: { deliverable?: boolean } = {},
): Promise<string> {
  const now = new Date();
  await EmailToken.updateMany({ ...ownerFilter(owner), usedAt: null }, { $set: { usedAt: now } }).exec();
  const _id = new Types.ObjectId();
  const code = randomCode();
  const hash =
    options.deliverable === false
      ? crypto.randomBytes(32).toString('hex')
      : codeHash(secret, owner.purpose, email, code, _id);
  await EmailToken.create({
    _id,
    userId: owner.purpose === 'change' ? owner.userId : null,
    purpose: owner.purpose,
    email,
    hash,
    attempts: 0,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    usedAt: null,
  });
  return code;
}

export type CodeCheck = { ok: true; record: IEmailToken } | { ok: false; remainingAttempts: number };

/** Checks a code against the owner's active code; counts wrong attempts and voids it after the last one. */
export async function checkCode(secret: string, owner: CodeOwner, code: string): Promise<CodeCheck> {
  const now = new Date();
  const record = await EmailToken.findOne({ ...ownerFilter(owner), usedAt: null, expiresAt: { $gt: now } })
    .sort({ createdAt: -1 })
    .lean<IEmailToken>()
    .exec();
  if (!record) return { ok: false, remainingAttempts: 0 };
  const expected = codeHash(secret, owner.purpose, record.email, code, record._id);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  const match = /^\d{6}$/.test(code) && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (match) {
    // single use, guarded against a concurrent redemption
    const used = await EmailToken.findOneAndUpdate(
      { _id: record._id, usedAt: null },
      { $set: { usedAt: now } },
      { new: true },
    )
      .lean<IEmailToken>()
      .exec();
    return used ? { ok: true, record: used } : { ok: false, remainingAttempts: 0 };
  }
  const updated = await EmailToken.findOneAndUpdate(
    { _id: record._id, usedAt: null },
    { $inc: { attempts: 1 } },
    { new: true },
  )
    .lean<IEmailToken>()
    .exec();
  const attempts = updated?.attempts ?? CODE_MAX_ATTEMPTS;
  const remainingAttempts = Math.max(0, CODE_MAX_ATTEMPTS - attempts);
  if (remainingAttempts === 0) {
    await EmailToken.updateOne({ _id: record._id }, { $set: { usedAt: now } }).exec();
  }
  return { ok: false, remainingAttempts };
}

/** Whether the owner was sent a code within `ms` (per-address / per-user resend throttle). */
export async function codeSentWithin(owner: CodeOwner, ms: number): Promise<boolean> {
  const since = new Date(Date.now() - ms);
  return !!(await EmailToken.exists({ ...ownerFilter(owner), createdAt: { $gte: since } }).exec());
}
