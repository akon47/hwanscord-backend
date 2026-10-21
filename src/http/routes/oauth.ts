import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toUser } from '../../lib/serialize.js';
import { User, type IUser } from '../../models/User.js';
import { signToken } from '../../services/auth.js';
import { storeAvatar } from '../../services/avatars.js';
import { GithubOAuthError } from '../../services/github.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { body, validate } from '../middleware/validate.js';
import { usernameSchema } from './auth.js';

export const STATE_COOKIE = 'hs_oauth_state';
const COOKIE_PATH = '/api/v1/auth/oauth';
const STATE_TTL_S = 10 * 60;
const SIGNUP_TTL_S = 15 * 60;

interface StateClaims {
  purpose: 'oauth-state';
  nonce: string;
  next: string;
  mode: 'login' | 'link';
  userId?: string;
}

interface SignupClaims {
  purpose: 'oauth-signup';
  provider: 'github';
  githubId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

/** Only same-site relative paths survive; anything else (absolute, protocol-relative, junk) becomes "/". */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/[\r\n]/.test(raw)) return '/';
  return raw;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

const completeSchema = z.object({
  signupToken: z.string().min(1).max(4096),
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(32).optional(),
});

export function oauthRoutes(ctx: AppContext): Router {
  const router = Router();
  const { config } = ctx;
  const secure = config.env === 'production';
  const limiter = makeRateLimiter(config, { windowMs: 60_000, limit: 10 });
  const startLimiter = makeRateLimiter(config, { windowMs: 60_000, limit: 30 });

  const resultUrl = (params: Record<string, string>) =>
    `${config.publicUrl}/oauth/callback#${new URLSearchParams(params).toString()}`;

  const issueState = (res: Response, claims: Omit<StateClaims, 'purpose' | 'nonce'>): string => {
    const nonce = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, nonce, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: COOKIE_PATH,
      maxAge: STATE_TTL_S * 1000,
    });
    const payload: StateClaims = { purpose: 'oauth-state', nonce, ...claims };
    return jwt.sign(payload, config.jwtSecret, { expiresIn: STATE_TTL_S });
  };

  router.get('/providers', (_req, res) => {
    res.json({ github: ctx.github.enabled });
  });

  router.get('/oauth/github/start', startLimiter, (req, res) => {
    const next = safeNext(req.query.next);
    if (!ctx.github.enabled) {
      res.redirect(302, resultUrl({ error: 'disabled' }));
      return;
    }
    const state = issueState(res, { next, mode: 'login' });
    res.redirect(302, ctx.github.authorizeUrl(state));
  });

  router.post('/oauth/github/link', requireAuth(ctx), (req, res) => {
    const me = currentUser(req);
    if (!ctx.github.enabled) throw ApiError.badRequest('GitHub 로그인이 설정되어 있지 않습니다.');
    const next = safeNext((req.body as { next?: unknown } | undefined)?.next ?? '/');
    const state = issueState(res, { next, mode: 'link', userId: me._id.toHexString() });
    res.json({ url: ctx.github.authorizeUrl(state) });
  });

  router.get('/oauth/github/callback', async (req, res) => {
    const cookieNonce = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: COOKIE_PATH });
    const fail = (error: string) => res.redirect(302, resultUrl({ error }));

    if (!ctx.github.enabled) return fail('disabled');
    let state: StateClaims;
    try {
      const decoded = jwt.verify(String(req.query.state ?? ''), config.jwtSecret) as Partial<StateClaims>;
      if (decoded.purpose !== 'oauth-state' || !decoded.nonce) throw new Error('bad state');
      state = decoded as StateClaims;
    } catch {
      return fail('state_mismatch');
    }
    if (!cookieNonce || cookieNonce !== state.nonce) return fail('state_mismatch');
    if (req.query.error) return fail('denied');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) return fail('denied');

    let profile;
    try {
      profile = await ctx.github.fetchProfile(code);
    } catch (err) {
      ctx.logger.warn({ err: err instanceof GithubOAuthError ? err.message : err }, 'github oauth failed');
      return fail('exchange_failed');
    }
    const next = safeNext(state.next);
    const owner = await User.findOne({
      oauthAccounts: { $elemMatch: { provider: 'github', providerId: profile.id } },
    })
      .lean<IUser>()
      .exec();

    if (state.mode === 'link') {
      if (!state.userId || !Types.ObjectId.isValid(state.userId)) return fail('state_mismatch');
      if (owner && owner._id.toHexString() !== state.userId) return fail('already_linked');
      if (!owner) {
        const updated = await User.updateOne(
          { _id: state.userId, 'oauthAccounts.provider': { $ne: 'github' } },
          {
            $push: {
              oauthAccounts: {
                provider: 'github',
                providerId: profile.id,
                login: profile.login,
                email: profile.email,
                linkedAt: new Date(),
              },
            },
          },
        ).exec();
        if (updated.matchedCount === 0) return fail('already_linked');
      }
      return res.redirect(302, resultUrl({ linked: 'github', next }));
    }

    if (owner) {
      // keep the stored login fresh (users can rename on GitHub)
      if (owner.oauthAccounts?.some((a) => a.providerId === profile.id && a.login !== profile.login)) {
        await User.updateOne(
          { _id: owner._id, 'oauthAccounts.providerId': profile.id },
          { $set: { 'oauthAccounts.$.login': profile.login } },
        ).exec();
      }
      const token = signToken(config, { sub: owner._id.toHexString(), username: owner.username });
      return res.redirect(302, resultUrl({ token, next }));
    }

    const signup: SignupClaims = {
      purpose: 'oauth-signup',
      provider: 'github',
      githubId: profile.id,
      login: profile.login,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      email: profile.email,
    };
    const signupToken = jwt.sign(signup, config.jwtSecret, { expiresIn: SIGNUP_TTL_S });
    return res.redirect(302, resultUrl({ signup: signupToken, next }));
  });

  router.post('/oauth/github/complete', limiter, validate({ body: completeSchema }), async (req, res) => {
    const input = body(req, completeSchema);
    let claims: SignupClaims;
    try {
      const decoded = jwt.verify(input.signupToken, config.jwtSecret) as Partial<SignupClaims>;
      if (decoded.purpose !== 'oauth-signup' || !decoded.githubId || !decoded.login) throw new Error('bad');
      claims = decoded as SignupClaims;
    } catch {
      throw ApiError.unauthorized('가입 정보가 만료되었습니다. GitHub 로 다시 시도하세요.');
    }
    const linked = await User.exists({
      oauthAccounts: { $elemMatch: { provider: 'github', providerId: claims.githubId } },
    }).exec();
    if (linked) throw ApiError.conflict('이 GitHub 계정은 이미 다른 계정에 연결되어 있습니다.');
    if (await User.exists({ username: input.username }).exec()) {
      throw ApiError.conflict('이미 사용 중인 아이디입니다.');
    }
    const isFirst = (await User.estimatedDocumentCount().exec()) === 0;
    const displayName = (input.displayName ?? claims.name ?? input.username).slice(0, 32);
    const created = await User.create({
      username: input.username,
      displayName,
      passwordHash: null,
      role: isFirst ? 'admin' : 'member',
      oauthAccounts: [
        {
          provider: 'github',
          providerId: claims.githubId,
          login: claims.login,
          email: claims.email,
          linkedAt: new Date(),
        },
      ],
    });
    let user = created.toObject() as IUser;
    if (claims.avatarUrl) {
      const image = await ctx.github.downloadAvatar(claims.avatarUrl);
      if (image) {
        try {
          const avatarUrl = await storeAvatar(config.uploadDir, user._id, image, null);
          const updated = await User.findByIdAndUpdate(user._id, { $set: { avatarUrl } }, { new: true })
            .lean<IUser>()
            .exec();
          if (updated) user = updated;
        } catch (err) {
          ctx.logger.debug({ err }, 'github avatar import skipped');
        }
      }
    }
    const token = signToken(config, { sub: user._id.toHexString(), username: user.username });
    ctx.realtime.emitAll('user:create', toUser(user, 'offline'));
    res.status(201).json({ token, user: toUser(user, 'offline', { self: true }) });
  });

  return router;
}
