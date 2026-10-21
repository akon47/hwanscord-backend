import pino from 'pino';
import sharp from 'sharp';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { User } from '../src/models/User.js';
import { auth, register, startTestApp, type TestApp } from './helpers.js';

const PUBLIC_URL = 'http://app.test';

interface FakeGithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

/** In-process fake of the three GitHub endpoints the server talks to, plus an avatar image. */
function fakeGithub() {
  const codes = new Map<string, FakeGithubUser>();
  let avatar: Buffer | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/login/oauth/access_token') {
      const { code } = JSON.parse(String(init?.body ?? '{}')) as { code?: string };
      return code && codes.has(code)
        ? json({ access_token: `tok-${code}` })
        : json({ error: 'bad_verification_code' });
    }
    const token = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace(
      'Bearer tok-',
      '',
    );
    if (url.pathname === '/user') {
      const user = codes.get(token);
      return user ? json(user) : json({ message: 'Bad credentials' }, 401);
    }
    if (url.pathname === '/user/emails') {
      const user = codes.get(token);
      return json(user ? [{ email: `${user.login}@users.example`, primary: true, verified: true }] : [], 200);
    }
    if (url.pathname === '/avatar.png' && avatar) {
      return new Response(avatar, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    code(user: FakeGithubUser) {
      const code = `code-${user.id}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, user);
      return code;
    },
    setAvatar(buf: Buffer) {
      avatar = buf;
    },
  };
}

const gh = fakeGithub();
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp(
    {
      PUBLIC_URL,
      GITHUB_CLIENT_ID: 'test-client',
      GITHUB_CLIENT_SECRET: 'test-secret',
      GITHUB_OAUTH_BASE_URL: 'https://gh.test',
      GITHUB_API_BASE_URL: 'https://api.gh.test',
    },
    gh.fetchImpl,
  );
});
afterEach(() => app.reset());
afterAll(() => app.stop());

function fragment(location: string): URLSearchParams {
  expect(location.startsWith(`${PUBLIC_URL}/oauth/callback#`)).toBe(true);
  return new URLSearchParams(location.split('#')[1]);
}

/** Runs start → (fake GitHub) → callback and returns the result fragment. */
async function githubRoundTrip(user: FakeGithubUser, options: { next?: string; linkToken?: string } = {}) {
  let state: string;
  let cookie: string;
  if (options.linkToken) {
    const res = await app.api
      .post('/api/v1/auth/oauth/github/link')
      .set(auth(options.linkToken))
      .send({ next: options.next ?? '/settings' })
      .expect(200);
    state = new URL(res.body.url).searchParams.get('state') as string;
    cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  } else {
    const res = await app.api
      .get('/api/v1/auth/oauth/github/start')
      .query({ next: options.next ?? '/channels/@me' })
      .expect(302);
    state = new URL(res.headers.location as string).searchParams.get('state') as string;
    cookie = (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  }
  const cb = await app.api
    .get('/api/v1/auth/oauth/github/callback')
    .query({ code: gh.code(user), state })
    .set('Cookie', cookie)
    .expect(302);
  return fragment(cb.headers.location as string);
}

const octo: FakeGithubUser = { id: 101, login: 'Octo-Cat', name: '옥토캣', avatar_url: null };

describe('oauth (github)', () => {
  it('reports the provider as enabled', async () => {
    const res = await app.api.get('/api/v1/auth/providers').expect(200);
    expect(res.body).toEqual({ github: true });
  });

  it('start redirects to GitHub with scope, redirect_uri and an HttpOnly state cookie', async () => {
    const res = await app.api.get('/api/v1/auth/oauth/github/start?next=//evil.example').expect(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe('https://gh.test/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC_URL}/api/v1/auth/oauth/github/callback`);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^hs_oauth_state=[0-9a-f]{32};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth\/oauth/);
  });

  it('rejects a callback whose cookie does not match the state', async () => {
    const start = await app.api.get('/api/v1/auth/oauth/github/start').expect(302);
    const state = new URL(start.headers.location as string).searchParams.get('state') as string;
    const cb = await app.api
      .get('/api/v1/auth/oauth/github/callback')
      .query({ code: gh.code(octo), state })
      .set('Cookie', 'hs_oauth_state=0000')
      .expect(302);
    expect(fragment(cb.headers.location as string).get('error')).toBe('state_mismatch');
    const noCookie = await app.api
      .get('/api/v1/auth/oauth/github/callback')
      .query({ code: gh.code(octo), state })
      .expect(302);
    expect(fragment(noCookie.headers.location as string).get('error')).toBe('state_mismatch');
  });

  it('maps a denied consent and a failed exchange to error codes', async () => {
    const start = await app.api.get('/api/v1/auth/oauth/github/start').expect(302);
    const state = new URL(start.headers.location as string).searchParams.get('state') as string;
    const cookie = (start.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    const denied = await app.api
      .get('/api/v1/auth/oauth/github/callback')
      .query({ error: 'access_denied', state })
      .set('Cookie', cookie)
      .expect(302);
    expect(fragment(denied.headers.location as string).get('error')).toBe('denied');
    const bad = await app.api
      .get('/api/v1/auth/oauth/github/callback')
      .query({ code: 'unknown-code', state })
      .set('Cookie', cookie)
      .expect(302);
    expect(fragment(bad.headers.location as string).get('error')).toBe('exchange_failed');
  });

  it('signs up a new identity, then logs it in directly', async () => {
    gh.setAvatar(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: '#5865f2' } })
        .png()
        .toBuffer(),
    );
    const first = await githubRoundTrip(
      { ...octo, avatar_url: 'https://avatars.gh.test/avatar.png' },
      { next: '/channels/x' },
    );
    const signup = first.get('signup');
    expect(signup).toBeTruthy();
    expect(first.get('next')).toBe('/channels/x');
    expect(first.get('token')).toBeNull();

    // a pending-signup token is never accepted as a session
    await app.api.get('/api/v1/auth/me').set(auth(signup!)).expect(401);

    const done = await app.api
      .post('/api/v1/auth/oauth/github/complete')
      .send({ signupToken: signup, username: 'octo-cat'.replace('-', '_') })
      .expect(201);
    expect(done.body.user.username).toBe('octo_cat');
    expect(done.body.user.displayName).toBe('옥토캣');
    expect(done.body.user.hasPassword).toBe(false);
    expect(done.body.user.connections).toEqual([{ provider: 'github', login: 'Octo-Cat' }]);
    expect(done.body.user.avatarUrl).toMatch(/^\/uploads\/avatars\/.+\.webp$/);
    expect(done.body.user.role).toBe('admin');

    // the same signup token cannot create a second account
    await app.api
      .post('/api/v1/auth/oauth/github/complete')
      .send({ signupToken: signup, username: 'another' })
      .expect(409);

    const again = await githubRoundTrip(octo);
    const token = again.get('token');
    expect(token).toBeTruthy();
    const me = await app.api.get('/api/v1/auth/me').set(auth(token!)).expect(200);
    expect(me.body.user.username).toBe('octo_cat');

    // no password yet: password login fails with the generic message
    const login = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'octo_cat', password: 'whatever-123' })
      .expect(401);
    expect(login.body.error.message).toBe('아이디 또는 비밀번호가 올바르지 않습니다.');
  });

  it('refuses a taken username at completion', async () => {
    await register(app, 'taken');
    const f = await githubRoundTrip({ id: 202, login: 'taken', name: null, avatar_url: null });
    const res = await app.api
      .post('/api/v1/auth/oauth/github/complete')
      .send({ signupToken: f.get('signup'), username: 'taken' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('links GitHub to a password account and refuses an identity owned by someone else', async () => {
    const alice = await register(app, 'alice');
    const linked = await githubRoundTrip(
      { id: 303, login: 'alice-gh', name: null, avatar_url: null },
      {
        linkToken: alice.token,
      },
    );
    expect(linked.get('linked')).toBe('github');
    expect(linked.get('next')).toBe('/settings');
    const me = await app.api.get('/api/v1/auth/me').set(auth(alice.token)).expect(200);
    expect(me.body.user.connections).toEqual([{ provider: 'github', login: 'alice-gh' }]);
    expect(me.body.user.hasPassword).toBe(true);

    // logging in with that GitHub identity now resolves to alice
    const login = await githubRoundTrip({ id: 303, login: 'alice-gh', name: null, avatar_url: null });
    const session = await app.api
      .get('/api/v1/auth/me')
      .set(auth(login.get('token')!))
      .expect(200);
    expect(session.body.user.username).toBe('alice');

    const bob = await register(app, 'bobby');
    const stolen = await githubRoundTrip(
      { id: 303, login: 'alice-gh', name: null, avatar_url: null },
      {
        linkToken: bob.token,
      },
    );
    expect(stolen.get('error')).toBe('already_linked');

    // alice can unlink because she has a password
    const unlinked = await app.api.delete('/api/v1/users/me/oauth/github').set(auth(alice.token)).expect(200);
    expect(unlinked.body.user.connections).toEqual([]);
    // and the identity is free again for bob
    const relink = await githubRoundTrip(
      { id: 303, login: 'alice-gh', name: null, avatar_url: null },
      {
        linkToken: bob.token,
      },
    );
    expect(relink.get('linked')).toBe('github');
  });

  it('keeps several users without identities (unique index ignores them)', async () => {
    await register(app, 'plain1');
    await register(app, 'plain2');
    expect(await User.countDocuments()).toBe(2);
  });

  it('refuses to unlink the last login method, and sets a first password without the current one', async () => {
    const f = await githubRoundTrip({ id: 404, login: 'solo', name: null, avatar_url: null });
    const done = await app.api
      .post('/api/v1/auth/oauth/github/complete')
      .send({ signupToken: f.get('signup'), username: 'solo' })
      .expect(201);
    const token = done.body.token as string;
    const refused = await app.api.delete('/api/v1/users/me/oauth/github').set(auth(token)).expect(409);
    expect(refused.body.error.message).toBe('마지막 로그인 수단은 해제할 수 없습니다.');

    await app.api
      .patch('/api/v1/users/me/password')
      .set(auth(token))
      .send({ newPassword: 'first-password-1' })
      .expect(204);
    const me = await app.api.get('/api/v1/auth/me').set(auth(token)).expect(200);
    expect(me.body.user.hasPassword).toBe(true);
    await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'solo', password: 'first-password-1' })
      .expect(200);

    // once a password exists, changing it requires the current one again
    await app.api
      .patch('/api/v1/users/me/password')
      .set(auth(token))
      .send({ newPassword: 'second-password-2' })
      .expect(401);
    await app.api.delete('/api/v1/users/me/oauth/github').set(auth(token)).expect(200);
  });
});

describe('oauth (github) disabled', () => {
  it('reports disabled and redirects start to an error', async () => {
    // providers/start never touch the database, so a second app needs no connection of its own
    const off = buildApp(
      loadConfig({ NODE_ENV: 'test', PUBLIC_URL, JWT_SECRET: app.config.jwtSecret, LOG_LEVEL: 'silent' }),
      { logger: pino({ level: 'silent' }) },
    );
    try {
      const api = supertest(off.server);
      expect((await api.get('/api/v1/auth/providers').expect(200)).body).toEqual({ github: false });
      const res = await api.get('/api/v1/auth/oauth/github/start').expect(302);
      expect(res.headers.location).toBe(`${PUBLIC_URL}/oauth/callback#error=disabled`);
    } finally {
      await off.close();
    }
  });
});
