import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { User, type IUser } from '../../models/User.js';
import { hashPassword, signToken, verifyPassword } from '../../services/auth.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { body, validate } from '../middleware/validate.js';

const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;
const LOGIN_FAILED = '아이디 또는 비밀번호가 올바르지 않습니다.';

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .regex(USERNAME_RE, '아이디는 2~32자의 영문 소문자, 숫자, 밑줄(_), 점(.)만 사용할 수 있습니다.'),
  password: z
    .string()
    .min(8, '비밀번호는 8자 이상이어야 합니다.')
    .max(72, '비밀번호는 72자 이하여야 합니다.'),
  displayName: z.string().trim().min(1).max(32).optional(),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(50),
  password: z.string().min(1).max(72),
});

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const limiter = makeRateLimiter(ctx.config, { windowMs: 60_000, limit: 10 });

  router.post('/register', limiter, validate({ body: registerSchema }), async (req, res) => {
    const input = body(req, registerSchema);
    const exists = await User.exists({ username: input.username }).exec();
    if (exists) throw ApiError.conflict('이미 사용 중인 아이디입니다.');
    const isFirst = (await User.estimatedDocumentCount().exec()) === 0;
    const created = await User.create({
      username: input.username,
      displayName: input.displayName ?? input.username,
      passwordHash: await hashPassword(input.password),
      role: isFirst ? 'admin' : 'member',
    });
    const user = created.toObject() as IUser;
    const token = signToken(ctx.config, { sub: user._id.toHexString(), username: user.username });
    ctx.realtime.emitAll('user:create', toUser(user, 'offline'));
    res.status(201).json({ token, user: toUser(user, 'offline', { self: true }) });
  });

  router.post('/login', limiter, validate({ body: loginSchema }), async (req, res) => {
    const input = body(req, loginSchema);
    const user = await User.findOne({ username: input.username }).select('+password').lean<IUser>().exec();
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
    const token = signToken(ctx.config, { sub: user._id.toHexString(), username: user.username });
    const presence = ctx.presence.effective(
      user._id.toHexString(),
      user.status ?? 'online',
      user._id.toHexString(),
    );
    res.json({ token, user: toUser(user, presence, { self: true }) });
  });

  router.get('/me', requireAuth(ctx), (req, res) => {
    const user = currentUser(req);
    const id = user._id.toHexString();
    res.json({ user: toUser(user, ctx.presence.effective(id, user.status, id), { self: true }) });
  });

  return router;
}
