import mongoose, { Schema, type Types } from 'mongoose';

/** signup / change: 6-digit codes; reset: link token */
export const EMAIL_TOKEN_PURPOSES = ['signup', 'change', 'reset'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

/**
 * One-time mail secret. Only a hash is stored: SHA-256 for link tokens, HMAC-SHA256 (keyed with JWT_SECRET, bound to
 * purpose, email and this document's id) for 6-digit codes. The secret itself exists only in the mail.
 */
export interface IEmailToken {
  _id: Types.ObjectId;
  /** null for `signup` (no account exists yet) */
  userId: Types.ObjectId | null;
  purpose: EmailTokenPurpose;
  /** the address the mail went to (for `change`: the new address) */
  email: string;
  hash: string;
  expiresAt: Date;
  usedAt: Date | null;
  /** wrong code attempts (codes only) */
  attempts: number;
  createdAt: Date;
}

const emailTokenSchema = new Schema<IEmailToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    email: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'emailtokens' },
);

// MongoDB removes expired tokens on its own (the background task runs about once a minute)
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailTokenSchema.index({ purpose: 1, email: 1, createdAt: -1 });

export const EmailToken = mongoose.model<IEmailToken>('EmailToken', emailTokenSchema);
