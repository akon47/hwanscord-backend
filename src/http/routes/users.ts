import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { USER_STATUSES, User, type IUser } from '../../models/User.js';
import { hashPassword, sessionToken, verifyPassword } from '../../services/auth.js';
import { removeAvatarFile, storeAvatar } from '../../services/avatars.js';
import { invalidateSessions, sendChangeMail, sendVerificationMail } from '../../services/accountMail.js';
import { countIssued } from '../../services/emailTokens.js';
import { emailSchema } from './auth.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { avatarUpload } from '../middleware/upload.js';
import { body, params, validate } from '../middleware/validate.js';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, '잘못된 식별자입니다.');
const idParams = z.object({ id: objectIdSchema });

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v === '' ? null : v));

export const patchMeSchema = z
  .object({
    displayName: z.string().trim().min(1, '표시 이름을 입력하세요.').max(32).optional(),
    aboutMe: nullableText(190).optional(),
    customStatus: nullableText(128).optional(),
    status: z.enum(USER_STATUSES).optional(),
    settings: z
      .record(z.unknown())
      .refine((v) => JSON.stringify(v).length <= 4096, '설정은 4KB 를 넘을 수 없습니다.')
      .optional(),
  })
  .strict();

export const passwordSchema = z.object({
  // optional only while the account has no password yet (created through GitHub)
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72),
});

export const changeEmailSchema = z.object({
  email: emailSchema,
  currentPassword: z.string().min(1).max(72).optional(),
});

/** 400 (not 401): a 401 would make the client treat the session as expired and sign out. */
function wrongCurrentPassword(): ApiError {
  return ApiError.validation('현재 비밀번호가 올바르지 않습니다.', {
    fieldErrors: { currentPassword: ['현재 비밀번호가 올바르지 않습니다.'] },
  });
}

async function assertCurrentPassword(
  userId: IUser['_id'],
  currentPassword: string | undefined,
): Promise<void> {
  const stored = await User.findById(userId)
    .select('passwordHash')
    .lean<Pick<IUser, 'passwordHash'>>()
    .exec();
  if (!stored) throw ApiError.notFound();
  if (!stored.passwordHash) return; // GitHub-only account: nothing to confirm
  if (!currentPassword || !(await verifyPassword(currentPassword, stored.passwordHash)))
    throw wrongCurrentPassword();
}

export function usersRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  const serialize = (user: IUser, viewer: IUser) =>
    toUser(user, ctx.presence.effective(user._id.toHexString(), user.status, viewer._id.toHexString()), {
      self: user._id.equals(viewer._id),
    });

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const users = await User.find()
      .collation({ locale: 'ko' })
      .sort({ displayName: 1, username: 1 })
      .lean<IUser[]>()
      .exec();
    res.json({ users: users.map((u) => serialize(u, me)) });
  });

  router.get('/me', (req, res) => {
    const me = currentUser(req);
    res.json({ user: serialize(me, me) });
  });

  router.patch('/me', validate({ body: patchMeSchema }), async (req, res) => {
    const me = currentUser(req);
    const input = body(req, patchMeSchema);
    const $set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) if (v !== undefined) $set[k] = v;
    if (Object.keys($set).length === 0) throw ApiError.validation('변경할 항목이 없습니다.');
    const updated = await User.findByIdAndUpdate(me._id, { $set }, { new: true }).lean<IUser>().exec();
    if (!updated) throw ApiError.notFound();
    broadcastUserUpdate(ctx, updated, input.status !== undefined && input.status !== me.status);
    res.json({ user: serialize(updated, updated) });
  });

  router.patch('/me/password', validate({ body: passwordSchema }), async (req, res) => {
    const me = currentUser(req);
    const input = body(req, passwordSchema);
    await assertCurrentPassword(me._id, input.currentPassword);
    // every other session is signed out; this client gets a fresh token
    const updated = await invalidateSessions(ctx, me._id, {
      passwordHash: await hashPassword(input.newPassword),
    });
    if (!updated) throw ApiError.notFound();
    res.json({ token: sessionToken(ctx.config, updated) });
  });

  router.post('/me/email/resend-verification', async (req, res) => {
    const me = currentUser(req);
    if (!me.email) throw ApiError.badRequest('등록된 이메일이 없습니다.');
    if (me.emailVerifiedAt) throw ApiError.badRequest('이미 인증된 이메일입니다.');
    if (!ctx.mailer.enabled) throw ApiError.mailDisabled();
    const now = Date.now();
    if ((await countIssued(me._id, 'verify', new Date(now - 60_000))) > 0) {
      throw ApiError.rateLimited('인증 메일은 1분에 한 번만 보낼 수 있어요.');
    }
    if ((await countIssued(me._id, 'verify', new Date(now - 24 * 60 * 60_000))) >= 5) {
      throw ApiError.rateLimited('오늘은 인증 메일을 더 보낼 수 없어요. 내일 다시 시도해 주세요.');
    }
    await sendVerificationMail(ctx, me, me.email);
    res.status(204).end();
  });

  router.patch('/me/email', validate({ body: changeEmailSchema }), async (req, res) => {
    const me = currentUser(req);
    const input = body(req, changeEmailSchema);
    await assertCurrentPassword(me._id, input.currentPassword);
    if (me.email === input.email) throw ApiError.badRequest('지금 쓰고 있는 이메일입니다.');
    if (await User.exists({ email: input.email, _id: { $ne: me._id } }).exec()) {
      throw ApiError.conflict('이미 사용 중인 이메일입니다.');
    }
    if (!ctx.mailer.enabled) throw ApiError.mailDisabled();
    await sendChangeMail(ctx, me, input.email);
    res.status(204).end();
  });

  router.put('/me/avatar', avatarUpload.single('avatar'), async (req, res) => {
    const me = currentUser(req);
    if (!req.file) throw ApiError.badRequest('avatar 파일이 필요합니다.');
    const avatarUrl = await storeAvatar(ctx.config.uploadDir, me._id, req.file.buffer, me.avatarUrl);
    const updated = await User.findByIdAndUpdate(me._id, { $set: { avatarUrl } }, { new: true })
      .lean<IUser>()
      .exec();
    if (!updated) throw ApiError.notFound();
    broadcastUserUpdate(ctx, updated, false);
    res.json({ user: serialize(updated, updated) });
  });

  router.delete('/me/avatar', async (req, res) => {
    const me = currentUser(req);
    if (me.avatarUrl) await removeAvatarFile(ctx.config.uploadDir, me.avatarUrl);
    const updated = await User.findByIdAndUpdate(me._id, { $set: { avatarUrl: null } }, { new: true })
      .lean<IUser>()
      .exec();
    if (!updated) throw ApiError.notFound();
    broadcastUserUpdate(ctx, updated, false);
    res.json({ user: serialize(updated, updated) });
  });

  router.delete('/me/oauth/github', async (req, res) => {
    const me = currentUser(req);
    if (!me.passwordHash) throw ApiError.conflict('마지막 로그인 수단은 해제할 수 없습니다.');
    const updated = await User.findByIdAndUpdate(
      me._id,
      { $pull: { oauthAccounts: { provider: 'github' } } },
      { new: true },
    )
      .lean<IUser>()
      .exec();
    if (!updated) throw ApiError.notFound();
    res.json({ user: serialize(updated, updated) });
  });

  router.get('/:id', validate({ params: idParams }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    const user = await User.findById(id).lean<IUser>().exec();
    if (!user) throw ApiError.notFound('사용자를 찾을 수 없습니다.');
    res.json({ user: serialize(user, me) });
  });

  return router;
}

/** `user:update` for everyone (public view) and `presence:update` when the chosen status changed. */
export function broadcastUserUpdate(ctx: AppContext, user: IUser, statusChanged: boolean): void {
  const id = user._id.toHexString();
  ctx.realtime.emitAll('user:update', toUser(user, ctx.presence.effective(id, user.status)));
  if (statusChanged) {
    ctx.realtime.emitAll('presence:update', {
      userId: id,
      presence: ctx.presence.effective(id, user.status),
    });
  }
}
