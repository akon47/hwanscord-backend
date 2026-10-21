import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export const USER_STATUSES = ['online', 'idle', 'dnd', 'invisible'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export type UserRole = 'admin' | 'member';

export interface IOAuthAccount {
  provider: 'github';
  providerId: string;
  login: string;
  email: string | null;
  linkedAt: Date;
}

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  displayName: string;
  /** null for accounts created through OAuth that never set a password */
  passwordHash: string | null;
  /** legacy v1 field, only present until the first successful login after migration */
  password?: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  customStatus: string | null;
  aboutMe: string | null;
  settings: Record<string, unknown>;
  /** lowercased; absent for accounts without email (the unique index only covers strings) */
  email?: string | null;
  emailVerifiedAt?: Date | null;
  /** bumped to sign out every session (password reset/change, temporary password) */
  tokenVersion?: number;
  /** absent (not []) for users who never linked an identity, so the unique index ignores them */
  oauthAccounts?: IOAuthAccount[];
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    displayName: { type: String, required: true, trim: true, maxlength: 32 },
    passwordHash: { type: String, default: null },
    password: { type: String, required: false, select: false },
    avatarUrl: { type: String, default: null },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    status: { type: String, enum: USER_STATUSES, default: 'online' },
    customStatus: { type: String, default: null, maxlength: 128 },
    aboutMe: { type: String, default: null, maxlength: 190 },
    settings: { type: Schema.Types.Mixed, default: () => ({}) },
    email: { type: String, lowercase: true, trim: true, maxlength: 254 },
    emailVerifiedAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    oauthAccounts: {
      type: [
        new Schema<IOAuthAccount>(
          {
            provider: { type: String, enum: ['github'], required: true },
            providerId: { type: String, required: true },
            login: { type: String, required: true },
            email: { type: String, default: null },
            linkedAt: { type: Date, default: () => new Date() },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
  },
  { timestamps: true, collection: 'users' },
);

// one account per email; $type is allowed in MongoDB 4.4 partial filters (unlike $in / $ne)
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });

// one account per external identity. Partial on $exists (allowed in MongoDB 4.4 partial filters, unlike $in):
// users without identities (field absent or []) are not indexed at all.
userSchema.index(
  { 'oauthAccounts.provider': 1, 'oauthAccounts.providerId': 1 },
  { unique: true, partialFilterExpression: { 'oauthAccounts.providerId': { $exists: true } } },
);

export const User = mongoose.model<IUser>('User', userSchema);
