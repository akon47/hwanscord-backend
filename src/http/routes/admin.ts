import crypto from 'node:crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { User, type IUser } from '../../models/User.js';
import { invalidateSessions } from '../../services/accountMail.js';
import { hashPassword } from '../../services/auth.js';
import { currentUser, requireAdmin, requireAuth } from '../middleware/auth.js';
import { params, validate } from '../middleware/validate.js';

const idParams = z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/, '잘못된 식별자입니다.') });

// no 0/O/1/l/I so the password can be read out loud or copied by hand
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

export function temporaryPassword(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx), requireAdmin());

  router.get('/users', async (_req, res) => {
    const users = await User.find()
      .collation({ locale: 'ko' })
      .sort({ displayName: 1, username: 1 })
      .lean<IUser[]>()
      .exec();
    res.json({
      users: users.map((u) => {
        const id = u._id.toHexString();
        // self-style serialization (email, emailVerified, hasPassword, connections) without the settings blob
        const { settings: _settings, ...dto } = toUser(u, ctx.presence.effective(id, u.status), {
          self: true,
        });
        return dto;
      }),
    });
  });

  router.post('/users/:id/temporary-password', validate({ params: idParams }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    if (me._id.toHexString() === id) {
      throw ApiError.badRequest('내 비밀번호는 설정의 비밀번호 변경에서 바꿔 주세요.');
    }
    const password = temporaryPassword();
    const updated = await invalidateSessions(ctx, new Types.ObjectId(id), {
      passwordHash: await hashPassword(password),
    });
    if (!updated) throw ApiError.notFound('사용자를 찾을 수 없습니다.');
    ctx.logger.info({ adminId: me._id.toHexString(), userId: id }, 'temporary password issued');
    res.json({ temporaryPassword: password });
  });

  return router;
}
