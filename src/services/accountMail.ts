import type { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import { User, type IUser } from '../models/User.js';
import { issueToken } from './emailTokens.js';
import { changeMail, resetMail, verifyMail } from './mailTemplates.js';

type MailUser = Pick<IUser, '_id' | 'displayName' | 'username'>;

const displayNameOf = (u: MailUser) => u.displayName || u.username;

export async function sendVerificationMail(ctx: AppContext, user: MailUser, email: string): Promise<void> {
  const token = await issueToken(user._id, 'verify', email);
  const url = `${ctx.config.publicUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send(verifyMail(email, displayNameOf(user), url));
}

export async function sendChangeMail(ctx: AppContext, user: MailUser, newEmail: string): Promise<void> {
  const token = await issueToken(user._id, 'change', newEmail);
  const url = `${ctx.config.publicUrl}/verify-email?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send(changeMail(newEmail, displayNameOf(user), url));
}

export async function sendResetMail(ctx: AppContext, user: MailUser, email: string): Promise<void> {
  const token = await issueToken(user._id, 'reset', email);
  const url = `${ctx.config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send(resetMail(email, displayNameOf(user), url));
}

/**
 * Signs the user out everywhere: bumps tokenVersion (every existing JWT becomes stale) and drops live sockets.
 * Returns the updated user.
 */
export async function invalidateSessions(
  ctx: AppContext,
  userId: Types.ObjectId,
  $set: Record<string, unknown> = {},
): Promise<IUser | null> {
  const updated = await User.findByIdAndUpdate(userId, { $set, $inc: { tokenVersion: 1 } }, { new: true })
    .lean<IUser>()
    .exec();
  ctx.realtime.disconnectUser(userId.toHexString());
  return updated;
}
