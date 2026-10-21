import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { User, type IUser } from '../../models/User.js';
import { hashPassword, sessionToken, verifyPassword } from '../../services/auth.js';
import { invalidateSessions, sendResetMail, sendSignupMail } from '../../services/accountMail.js';
import { checkCode, codeSentWithin } from '../../services/emailCodes.js';
import { consumeToken, countIssued } from '../../services/emailTokens.js';
import { USERNAME_RE, freeUsername, sanitizeUsername, usernameFromEmail } from '../../services/usernames.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { body, query, validate } from '../middleware/validate.js';

const LOGIN_FAILED = '이메일(아이디) 또는 비밀번호가 올바르지 않습니다.';
const SIGNUP_TOKEN_TTL_S = 30 * 60;

export const usernameSchema = z
  .string()
  .trim()
  .regex(USERNAME_RE, '사용자명은 2~32자의 영문 소문자, 숫자, 밑줄(_), 점(.)만 사용할 수 있습니다.');

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

export const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, '6자리 숫자 코드를 입력하세요.');

const startSchema = z.object({ email: emailSchema });
const verifyCodeSchema = z.object({ email: emailSchema, code: codeSchema });

export const registerSchema = z.object({
  signupToken: z.string().min(1).max(4096),
  password: passwordField,
  displayName: z.string().trim().min(1).max(32).optional(),
  username: usernameSchema.optional(),
});

export const loginSchema = z
  .object({
    /** the email, or the username for accounts without one */
    login: z.string().trim().min(1).max(254).optional(),
    /** alias of `login` kept for older clients */
    username: z.string().trim().min(1).max(254).optional(),
    password: z.string().min(1).max(72),
  })
  .refine((v) => !!(v.login ?? v.username), { message: '이메일을 입력하세요.', path: ['login'] });

const availabilityQuery = z.object({ username: z.string().trim().min(1).max(64) });
const forgotSchema = z.object({ login: z.string().trim().min(1).max(254) });
const resetSchema = z.object({ token: z.string().min(1).max(200), newPassword: passwordField });

const TOKEN_INVALID = '링크가 만료되었거나 이미 사용되었습니다.';
export const CODE_WRONG = '인증 코드가 올바르지 않습니다.';
export const CODE_VOID = '인증 코드가 만료되었습니다. 코드를 다시 받아 주세요.';

/**
 * Resolves a login ID: the email (case-insensitive) when it contains '@', the username otherwise.
 * Falls back to an exact username match, because some legacy v1 usernames look like email addresses.
 */
export async function findByLogin(login: string, withLegacyPassword = false): Promise<IUser | null> {
  const lookup = (filter: Record<string, string>) => {
    const q = User.findOne(filter);
    if (withLegacyPassword) q.select('+password');
    return q.lean<IUser>().exec();
  };
  if (login.includes('@')) {
    return (await lookup({ email: login.toLowerCase() })) ?? (await lookup({ username: login }));
  }
  return (
    (await lookup({ username: login })) ??
    (login !== login.toLowerCase() ? await lookup({ username: login.toLowerCase() }) : null)
  );
}

/** 400 with the number of attempts left (0 = the code is void, ask for a new one). */
export function codeError(remainingAttempts: number): ApiError {
  return ApiError.badRequest(remainingAttempts > 0 ? CODE_WRONG : CODE_VOID, { remainingAttempts });
}

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = makeRateLimiter(ctx.config, { windowMs: 60_000, limit: 10 });
  const startIpLimiter = makeRateLimiter(ctx.config, { windowMs: 60 * 60_000, limit: 5 });

  // ---- signup step 1: send a code (or an "already registered" notice) -------------------------------
  router.post('/register/start', startIpLimiter, validate({ body: startSchema }), async (req, res) => {
    const { email } = body(req, startSchema);
    if (!ctx.mailer.enabled) throw ApiError.mailDisabled();
    if (await codeSentWithin({ purpose: 'signup', email }, 60_000)) {
      throw ApiError.rateLimited('인증 코드는 1분에 한 번만 보낼 수 있어요.');
    }
    const existing = !!(await User.exists({ email }).exec());
    await sendSignupMail(ctx, email, existing);
    res.status(204).end();
  });

  // ---- signup step 2: exchange the code for a short-lived signup token --------------------------------
  router.post('/register/verify', limiter, validate({ body: verifyCodeSchema }), async (req, res) => {
    const { email, code } = body(req, verifyCodeSchema);
    const result = await checkCode(ctx.config.jwtSecret, { purpose: 'signup', email }, code);
    if (!result.ok) throw codeError(result.remainingAttempts);
    const signupToken = jwt.sign({ purpose: 'email-signup', email }, ctx.config.jwtSecret, {
      expiresIn: SIGNUP_TOKEN_TTL_S,
    });
    res.json({ signupToken });
  });

  // ---- signup step 3: create the account ---------------------------------------------------------------
  router.post('/register', limiter, validate({ body: registerSchema }), async (req, res) => {
    const input = body(req, registerSchema);
    let email: string;
    try {
      const decoded = jwt.verify(input.signupToken, ctx.config.jwtSecret) as {
        purpose?: unknown;
        email?: unknown;
      };
      if (decoded.purpose !== 'email-signup' || typeof decoded.email !== 'string')
        throw new Error('bad token');
      email = decoded.email;
    } catch {
      throw ApiError.unauthorized('이메일 인증이 만료되었습니다. 처음부터 다시 진행해 주세요.');
    }
    if (await User.exists({ email }).exec()) throw ApiError.conflict('이미 사용 중인 이메일입니다.');
    let username: string;
    if (input.username) {
      if (await User.exists({ username: input.username }).exec()) {
        throw ApiError.conflict('이미 사용 중인 사용자명입니다.');
      }
      username = input.username;
    } else {
      username = await freeUsername(usernameFromEmail(email));
    }
    const isFirst = (await User.estimatedDocumentCount().exec()) === 0;
    const created = await User.create({
      username,
      displayName: input.displayName ?? username,
      passwordHash: await hashPassword(input.password),
      email,
      emailVerifiedAt: new Date(),
      role: isFirst ? 'admin' : 'member',
    });
    const user = created.toObject() as IUser;
    const token = sessionToken(ctx.config, user);
    ctx.realtime.emitAll('user:create', toUser(user, 'offline'));
    res.status(201).json({ token, user: toUser(user, 'offline', { self: true }) });
  });

  router.get('/username-available', limiter, validate({ query: availabilityQuery }), async (req, res) => {
    const { username } = query(req, availabilityQuery);
    const candidate = username.toLowerCase();
    const valid = USERNAME_RE.test(candidate);
    const available = valid && !(await User.exists({ username: candidate }).exec());
    const suggestion = available ? candidate : await freeUsername(sanitizeUsername(candidate));
    res.json({ available, suggestion });
  });

  router.post('/login', limiter, validate({ body: loginSchema }), async (req, res) => {
    const input = body(req, loginSchema);
    const login = (input.login ?? input.username) as string;
    const user = await findByLogin(login, true);
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

  const forgotIpLimiter = makeRateLimiter(ctx.config, { windowMs: 60 * 60_000, limit: 5 });
  router.post('/password/forgot', forgotIpLimiter, validate({ body: forgotSchema }), async (req, res) => {
    const { login } = body(req, forgotSchema);
    // always 204: the response must not reveal whether the account or email exists
    try {
      const user = await findByLogin(login);
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
    if (!record?.userId) throw ApiError.badRequest(TOKEN_INVALID);
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
