import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { User, type IUser } from '../../models/User.js';
import { hashPassword, sessionToken, verifyPassword } from '../../services/auth.js';
import { invalidateSessions, sendResetMail, sendVerificationMail } from '../../services/accountMail.js';
import { consumeToken, countIssued } from '../../services/emailTokens.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { body, validate } from '../middleware/validate.js';

const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않습니다.';

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, '아이디는 2~32자의 영문 소문자, 숫자, 밑줄(_), 점(.)만 사용할 수 있습니다.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, '이메일은 254자 이하여야 합니다.')
  .email('올바른 이메일 주소를 입력하세요.');

export const passwordField = z
  .string()
  .min(8, '비밀번호는 8자 이상이어야 합니다.')
  .max(72, '비밀번호는 72자 이하여야 합니다.');

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: z
    .string()
    .min(8, '비밀번호는 8자 이상이어야 합니다.')
    .max(72, '비밀번호는 72자 이하여야 합니다.'),
  displayName: z.string().trim().min(1).max(32).optional(),
});

export const loginSchema = z.object({
  /** username, or the account email when it contains '@' */
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(72),
});

const verifySchema = z.object({ token: z.string().min(1).max(200) });
const forgotSchema = z.object({ login: z.string().trim().min(1).max(254) });
const resetSchema = z.object({ token: z.string().min(1).max(200), newPassword: passwordField });

const TOKEN_INVALID = '링크가 만료되었거나 이미 사용되었습니다.';

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = makeRateLimiter(ctx.config, { windowMs: 60_000, limit: 10 });

  router.post('/register', limiter, validate({ body: registerSchema }), async (req, res) => {
    const input = body(req, registerSchema);
    const exists = await User.exists({ username: input.username }).exec();
    if (exists) throw ApiError.conflict('이미 사용 중인 아이디입니다.');
    if (await User.exists({ email: input.email }).exec())
      throw ApiError.conflict('이미 사용 중인 이메일입니다.');
    const isFirst = (await User.estimatedDocumentCount().exec()) === 0;
    const created = await User.create({
      username: input.username,
      displayName: input.displayName ?? input.username,
      passwordHash: await hashPassword(input.password),
      email: input.email,
      emailVerifiedAt: null,
      role: isFirst ? 'admin' : 'member',
    });
    const user = created.toObject() as IUser;
    // the account is usable right away; a mail problem must not fail the registration
    try {
      await sendVerificationMail(ctx, user, input.email);
    } catch (err) {
      ctx.logger.warn(
        { err: (err as Error).message, userId: user._id.toHexString() },
        'verification mail not sent',
      );
    }
    const token = sessionToken(ctx.config, user);
    ctx.realtime.emitAll('user:create', toUser(user, 'offline'));
    res.status(201).json({ token, user: toUser(user, 'offline', { self: true }) });
  });

  router.post('/login', limiter, validate({ body: loginSchema }), async (req, res) => {
    const input = body(req, loginSchema);
    const filter = input.username.includes('@')
      ? { email: input.username.toLowerCase() }
      : { username: input.username };
    const user = await User.findOne(filter).select('+password').lean<IUser>().exec();
    if (!user) throw ApiError.unauthorized(LOGIN_FAILED);
    const hash = user.passwordHash ?? user.password;
    if (!hash || !(await verifyPassword(input.password, hash))) throw ApiError.unauthorized(LOGIN_FAILED);
    if (!user.passwordHash && user.password) {
      // un-migrated v1 account: move the hash to the new field on first login
      await User.updateOne(
        { _id: user._id },
        { $set: { passwordHash: user.password }, $unset: { password: '' } },
      ).exec();
    }
    const token = sessionToken(ctx.config, user);
    const presence = ctx.presence.effective(
      user._id.toHexString(),
      user.status ?? 'online',
      user._id.toHexString(),
    );
    res.json({ token, user: toUser(user, presence, { self: true }) });
  });

  router.post('/verify-email', limiter, validate({ body: verifySchema }), async (req, res) => {
    const { token } = body(req, verifySchema);
    const record = await consumeToken(token, ['verify', 'change']);
    if (!record) throw ApiError.badRequest(TOKEN_INVALID);
    const user = await User.findById(record.userId).lean<IUser>().exec();
    if (!user) throw ApiError.badRequest(TOKEN_INVALID);
    let updated: IUser | null;
    if (record.purpose === 'verify') {
      // the address may have been changed since the mail was sent
      if (user.email !== record.email) throw ApiError.badRequest(TOKEN_INVALID);
      updated = await User.findByIdAndUpdate(
        user._id,
        { $set: { emailVerifiedAt: new Date() } },
        { new: true },
      )
        .lean<IUser>()
        .exec();
    } else {
      const taken = await User.exists({ email: record.email, _id: { $ne: user._id } }).exec();
      if (taken) throw ApiError.conflict('이미 사용 중인 이메일입니다.');
      updated = await User.findByIdAndUpdate(
        user._id,
        { $set: { email: record.email, emailVerifiedAt: new Date() } },
        { new: true },
      )
        .lean<IUser>()
        .exec();
    }
    if (!updated) throw ApiError.badRequest(TOKEN_INVALID);
    const id = updated._id.toHexString();
    res.json({ user: toUser(updated, ctx.presence.effective(id, updated.status, id), { self: true }) });
  });

  const forgotIpLimiter = makeRateLimiter(ctx.config, { windowMs: 60 * 60_000, limit: 5 });
  router.post('/password/forgot', forgotIpLimiter, validate({ body: forgotSchema }), async (req, res) => {
    const { login } = body(req, forgotSchema);
    // always 204: the response must not reveal whether the account or email exists
    try {
      const filter = login.includes('@') ? { email: login.toLowerCase() } : { username: login };
      const user = await User.findOne(filter).lean<IUser>().exec();
      if (user?.email && user.emailVerifiedAt) {
        const recent = await countIssued(user._id, 'reset', new Date(Date.now() - 60 * 60_000));
        if (recent < 3) await sendResetMail(ctx, user, user.email);
        else ctx.logger.info({ userId: user._id.toHexString() }, 'password reset mail throttled');
      }
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'password reset mail not sent');
    }
    res.status(204).end();
  });

  router.post('/password/reset', limiter, validate({ body: resetSchema }), async (req, res) => {
    const { token, newPassword } = body(req, resetSchema);
    const record = await consumeToken(token, ['reset']);
    if (!record) throw ApiError.badRequest(TOKEN_INVALID);
    const updated = await invalidateSessions(ctx, record.userId, {
      passwordHash: await hashPassword(newPassword),
    });
    if (!updated) throw ApiError.badRequest(TOKEN_INVALID);
    res.status(204).end();
  });

  router.get('/me', requireAuth(ctx), (req, res) => {
    const user = currentUser(req);
    const id = user._id.toHexString();
    res.json({ user: toUser(user, ctx.presence.effective(id, user.status, id), { self: true }) });
  });

  return router;
}
