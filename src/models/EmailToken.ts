import mongoose, { Schema, type Types } from 'mongoose';

export const EMAIL_TOKEN_PURPOSES = ['verify', 'reset', 'change'] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

/** One-time mail token. Only the SHA-256 of the token is stored; the token itself exists only in the mail. */
export interface IEmailToken {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  purpose: EmailTokenPurpose;
  /** the address the mail went to (for `change`: the new address) */
  email: string;
  hash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

const emailTokenSchema = new Schema<IEmailToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: EMAIL_TOKEN_PURPOSES, required: true },
    email: { type: String, required: true },
    hash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'emailtokens' },
);

// MongoDB removes expired tokens on its own (the background task runs about once a minute)
emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailToken = mongoose.model<IEmailToken>('EmailToken', emailTokenSchema);
