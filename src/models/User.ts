import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export const USER_STATUSES = ['online', 'idle', 'dnd', 'invisible'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export type UserRole = 'admin' | 'member';

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  displayName: string;
  passwordHash: string;
  /** legacy v1 field, only present until the first successful login after migration */
  password?: string;
  avatarUrl: string | null;
  role: UserRole;
  status: UserStatus;
  customStatus: string | null;
  aboutMe: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true, maxlength: 50 },
    displayName: { type: String, required: true, trim: true, maxlength: 32 },
    passwordHash: { type: String, required: true },
    password: { type: String, required: false, select: false },
    avatarUrl: { type: String, default: null },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    status: { type: String, enum: USER_STATUSES, default: 'online' },
    customStatus: { type: String, default: null, maxlength: 128 },
    aboutMe: { type: String, default: null, maxlength: 190 },
    settings: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: true, collection: 'users' },
);

export const User = mongoose.model<IUser>('User', userSchema);
