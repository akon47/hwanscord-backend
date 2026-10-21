import type { Types } from 'mongoose';
import type { AppContext } from '../context.js';
import { User, type IUser } from '../models/User.js';
import { issueCode } from './emailCodes.js';
import { issueToken } from './emailTokens.js';
import { alreadyRegisteredMail, changeCodeMail, resetMail, signupCodeMail } from './mailTemplates.js';

type MailUser = Pick<IUser, '_id' | 'displayName' | 'username'>;

const displayNameOf = (u: MailUser) => u.displayName || u.username;

/** Signup step 1: a code for a new address, or a notice for an address that already has an account. */
export async function sendSignupMail(ctx: AppContext, email: string, existing: boolean): Promise<void> {
  if (existing) {
    // record an unredeemable code so the throttle and the response stay identical (no enumeration)
    await issueCode(ctx.config.jwtSecret, { purpose: 'signup', email }, email, { deliverable: false });
    await ctx.mailer.send(
      alreadyRegisteredMail(
        email,
        `${ctx.config.publicUrl}/login`,
        `${ctx.config.publicUrl}/forgot-password`,
      ),
    );
    return;
  }
  const code = await issueCode(ctx.config.jwtSecret, { purpose: 'signup', email }, email);
  await ctx.mailer.send(signupCodeMail(email, code));
}

export async function sendChangeCode(ctx: AppContext, user: MailUser, email: string): Promise<void> {
  const code = await issueCode(ctx.config.jwtSecret, { purpose: 'change', userId: user._id }, email);
  await ctx.mailer.send(changeCodeMail(email, displayNameOf(user), code));
}

export async function sendResetMail(ctx: AppContext, user: MailUser, email: string): Promise<void> {
  const token = await issueToken(user._id, 'reset', email);
  const url = `${ctx.config.publicUrl}/reset-password#token=${encodeURIComponent(token)}`;
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
