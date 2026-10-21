import { io as ioc, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EmailToken } from '../src/models/EmailToken.js';
import { Meta } from '../src/models/Meta.js';
import { User } from '../src/models/User.js';
import { auth, register, startTestApp, waitFor, type TestApp } from './helpers.js';

const PUBLIC_URL = 'http://app.test';
const RESEND = 'https://resend.test';
const LIMIT = 50;

interface SentMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  from: string;
}

const sent: SentMail[] = [];
let resendDown = false;
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === `${RESEND}/emails`) {
    if (resendDown) return new Response('{}', { status: 500 });
    const authz = (init?.headers as Record<string, string>).Authorization;
    if (authz !== 'Bearer re_test_key') return new Response('{}', { status: 401 });
    const b = JSON.parse(String(init?.body)) as {
      to: string[];
      subject: string;
      html: string;
      text: string;
      from: string;
    };
    sent.push({ to: b.to[0]!, subject: b.subject, html: b.html, text: b.text, from: b.from });
    return new Response(JSON.stringify({ id: `m${sent.length}` }), { status: 200 });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

let app: TestApp;
const sockets: Socket[] = [];

beforeAll(async () => {
  app = await startTestApp(
    {
      PUBLIC_URL,
      RESEND_API_KEY: 're_test_key',
      RESEND_API_BASE_URL: RESEND,
      MAIL_DAILY_LIMIT: String(LIMIT),
    },
    fetchImpl,
  );
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  sent.length = 0;
  resendDown = false;
  await app.reset();
});
afterAll(() => app.stop());

/** Pulls the one-time token out of the last mail sent to `to` (the link path must match). */
function tokenFrom(to: string, path: '/verify-email' | '/reset-password'): string {
  const mail = [...sent].reverse().find((m) => m.to === to);
  expect(mail, `mail to ${to}`).toBeTruthy();
  const m = mail!.text.match(new RegExp(`${PUBLIC_URL}${path}\#token=([A-Za-z0-9_-]+)`));
  expect(m, 'link in mail').toBeTruthy();
  return decodeURIComponent(m![1]!);
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioc(app.baseUrl, {
      path: '/socket.io/',
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    socket.once('ready', () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

describe('email verification', () => {
  it('register requires an email, sends a verification mail, and refuses duplicates', async () => {
    await app.api
      .post('/api/v1/auth/register')
      .send({ username: 'noemail', password: 'password-123' })
      .expect(400);
    const a = await register(app, 'alice');
    expect(a.user).toMatchObject({ email: 'alice@test.example', emailVerified: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'alice@test.example', from: 'HWANSCORD <noreply@kimhwan.kr>' });
    expect(sent[0]!.subject).toContain('인증');
    expect(sent[0]!.html).toContain('#5865f2');
    expect(sent[0]!.html).toContain('본인이 요청하지 않았다면');
    const dup = await app.api
      .post('/api/v1/auth/register')
      .send({ username: 'bob', email: 'ALICE@test.example', password: 'password-123' })
      .expect(409);
    expect(dup.body.error.message).toBe('이미 사용 중인 이메일입니다.');
  });

  it('only stores a hash of the token', async () => {
    await register(app, 'alice');
    const token = tokenFrom('alice@test.example', '/verify-email');
    const stored = await EmailToken.findOne().lean();
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('verifies once; the link is single use and expires', async () => {
    const a = await register(app, 'alice');
    const token = tokenFrom('alice@test.example', '/verify-email');
    const ok = await app.api.post('/api/v1/auth/verify-email').send({ token }).expect(200);
    expect(ok.body.user.emailVerified).toBe(true);
    const again = await app.api.post('/api/v1/auth/verify-email').send({ token }).expect(400);
    expect(again.body.error.message).toBe('링크가 만료되었거나 이미 사용되었습니다.');
    const me = await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(200);
    expect(me.body.user.emailVerified).toBe(true);

    await register(app, 'bob');
    const late = tokenFrom('bob@test.example', '/verify-email');
    await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await app.api.post('/api/v1/auth/verify-email').send({ token: late }).expect(400);
  });

  it('throttles resending: once per minute, five per day', async () => {
    const a = await register(app, 'alice');
    const tooSoon = await app.api
      .post('/api/v1/users/me/email/resend-verification')
      .set(auth(a.token))
      .expect(429);
    expect(tooSoon.body.error.code).toBe('RATE_LIMITED');
    await EmailToken.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    await app.api.post('/api/v1/users/me/email/resend-verification').set(auth(a.token)).expect(204);
    expect(sent).toHaveLength(2);
    // the older link is void once a new one is issued
    const old = await EmailToken.find().sort({ createdAt: 1 }).lean();
    expect(old[0]!.usedAt).not.toBeNull();

    const user = await User.findOne({ username: 'alice' }).lean();
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await EmailToken.collection.insertMany(
      [1, 2, 3].map((i) => ({
        userId: user!._id,
        purpose: 'verify' as const,
        email: 'alice@test.example',
        hash: `${'0'.repeat(63)}${i}`,
        expiresAt: new Date(Date.now() + 3600_000),
        usedAt: null,
        createdAt: hourAgo,
      })),
    );
    await EmailToken.collection.updateMany({}, { $set: { createdAt: hourAgo } });
    const daily = await app.api
      .post('/api/v1/users/me/email/resend-verification')
      .set(auth(a.token))
      .expect(429);
    expect(daily.body.error.message).toContain('오늘');

    // nothing to resend once verified
    await User.updateOne({ username: 'alice' }, { $set: { emailVerifiedAt: new Date() } });
    await app.api.post('/api/v1/users/me/email/resend-verification').set(auth(a.token)).expect(400);
  });

  it('changes the email only after the new address is confirmed', async () => {
    const a = await register(app, 'alice');
    await register(app, 'bob');
    sent.length = 0;
    const wrong = await app.api
      .patch('/api/v1/users/me/email')
      .set(auth(a.token))
      .send({ email: 'new@test.example', currentPassword: 'nope-nope' })
      .expect(400);
    expect(wrong.body.error.details.fieldErrors.currentPassword).toBeDefined();
    await app.api
      .patch('/api/v1/users/me/email')
      .set(auth(a.token))
      .send({ email: 'bob@test.example', currentPassword: 'alice-password-1' })
      .expect(409);
    await app.api
      .patch('/api/v1/users/me/email')
      .set(auth(a.token))
      .send({ email: 'New@Test.example', currentPassword: 'alice-password-1' })
      .expect(204);
    expect(sent.map((m) => m.to)).toEqual(['new@test.example']);
    let me = await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(200);
    expect(me.body.user.email).toBe('alice@test.example');

    const token = tokenFrom('new@test.example', '/verify-email');
    const done = await app.api.post('/api/v1/auth/verify-email').send({ token }).expect(200);
    expect(done.body.user).toMatchObject({ email: 'new@test.example', emailVerified: true });
    me = await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(200);
    expect(me.body.user.email).toBe('new@test.example');
  });

  it('never shows emails to other users', async () => {
    const a = await register(app, 'alice');
    await register(app, 'bob');
    const list = await app.api.get('/api/v1/users').set(auth(a.token)).expect(200);
    const bob = list.body.users.find((u: { username: string }) => u.username === 'bob');
    expect(bob.email).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain('bob@test.example');
  });

  it('logs in with the email instead of the username', async () => {
    await register(app, 'alice');
    const res = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'Alice@Test.Example', password: 'alice-password-1' })
      .expect(200);
    expect(res.body.user.username).toBe('alice');
    const bad = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'alice@test.example', password: 'wrong-password' })
      .expect(401);
    expect(bad.body.error.message).toBe('아이디 또는 비밀번호가 올바르지 않습니다.');
  });
});

describe('password reset', () => {
  it('forgot is always 204 and only mails verified addresses', async () => {
    await register(app, 'alice'); // unverified
    sent.length = 0;
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'nobody' }).expect(204);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'nobody@test.example' }).expect(204);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    expect(sent).toHaveLength(0);

    await User.updateOne({ username: 'alice' }, { $set: { emailVerifiedAt: new Date() } });
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice@test.example' }).expect(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain('비밀번호');
    expect(sent[0]!.text).toContain('30분');

    // 3 per hour per account, then silently dropped
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    expect(sent).toHaveLength(3);

    // a mail outage does not change the answer either
    resendDown = true;
    await EmailToken.deleteMany({});
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
  });

  it('resets once, expires, and signs out every session (REST and socket)', async () => {
    const a = await register(app, 'alice');
    await User.updateOne({ username: 'alice' }, { $set: { emailVerifiedAt: new Date() } });
    const live = await connect(a.token);
    const dropped = new Promise<void>((resolve) => live.once('disconnect', () => resolve()));

    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    const token = tokenFrom('alice@test.example', '/reset-password');
    await app.api.post('/api/v1/auth/password/reset').send({ token, newPassword: 'short' }).expect(400);
    await app.api
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'brand-new-password' })
      .expect(204);
    await app.api
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'another-password' })
      .expect(400);

    await dropped; // the live socket was disconnected
    await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(401);
    await expect(connect(a.token)).rejects.toThrow('unauthorized');
    await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'alice-password-1' })
      .expect(401);
    const fresh = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'brand-new-password' })
      .expect(200);
    await app.api.get('/api/v1/auth/me').set(auth(fresh.body.token)).expect(200);
    await connect(fresh.body.token);

    // an expired reset link is refused
    await EmailToken.deleteMany({});
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    const late = tokenFrom('alice@test.example', '/reset-password');
    await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await app.api
      .post('/api/v1/auth/password/reset')
      .send({ token: late, newPassword: 'late-password-1' })
      .expect(400);
  });

  it('accepts legacy tokens without a tv claim while tokenVersion is 0', async () => {
    const a = await register(app, 'alice');
    const jwt = await import('jsonwebtoken');
    const legacy = jwt.default.sign({ sub: a.user.id, username: 'alice' }, app.config.jwtSecret, {
      expiresIn: '1h',
    });
    await app.api.get('/api/v1/auth/me').set(auth(legacy)).expect(200);
  });
});

describe('mail budget', () => {
  it('stops sending at the daily limit with 503 MAIL_QUOTA', async () => {
    const a = await register(app, 'alice');
    sent.length = 0;
    const key = `mail:sent:${new Date().toISOString().slice(0, 10)}`;
    await Meta.updateOne({ key }, { $set: { value: LIMIT } }, { upsert: true });
    await EmailToken.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    const res = await app.api
      .post('/api/v1/users/me/email/resend-verification')
      .set(auth(a.token))
      .expect(503);
    expect(res.body.error.code).toBe('MAIL_QUOTA');
    expect(sent).toHaveLength(0);
    const counter = await Meta.findOne({ key }).lean();
    expect(counter?.value).toBe(LIMIT);
    // registration still works when no mail can be sent
    await register(app, 'bob');
    expect(sent).toHaveLength(0);
  });
});

describe('admin', () => {
  it('lists users with email status and issues a temporary password once', async () => {
    const admin = await register(app, 'boss');
    const member = await register(app, 'carol');
    await app.api.get('/api/v1/admin/users').set(auth(member.token)).expect(403);
    const list = await app.api.get('/api/v1/admin/users').set(auth(admin.token)).expect(200);
    const carol = list.body.users.find((u: { username: string }) => u.username === 'carol');
    expect(carol).toMatchObject({ email: 'carol@test.example', emailVerified: false, hasPassword: true });
    expect(carol.settings).toBeUndefined();

    const live = await connect(member.token);
    const dropped = new Promise<void>((resolve) => live.once('disconnect', () => resolve()));
    await app.api
      .post(`/api/v1/admin/users/${member.user.id}/temporary-password`)
      .set(auth(member.token))
      .expect(403);
    const res = await app.api
      .post(`/api/v1/admin/users/${member.user.id}/temporary-password`)
      .set(auth(admin.token))
      .expect(200);
    const temp = res.body.temporaryPassword as string;
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
    await dropped;
    await app.api.get('/api/v1/auth/me').set(auth(member.token)).expect(401);
    await app.api.post('/api/v1/auth/login').send({ username: 'carol', password: temp }).expect(200);
    await app.api
      .post(`/api/v1/admin/users/${admin.user.id}/temporary-password`)
      .set(auth(admin.token))
      .expect(400);
  });
});

describe('mail disabled', () => {
  it('registration works and mail endpoints answer 503 MAIL_DISABLED', async () => {
    // same app, key removed at runtime is not possible; exercise the Mailer directly instead
    const { Mailer } = await import('../src/services/mailer.js');
    const pino = (await import('pino')).default;
    const mailer = new Mailer(
      { apiKey: undefined, from: 'x', dailyLimit: 10, apiBaseUrl: RESEND },
      pino({ level: 'silent' }),
      fetchImpl,
    );
    expect(mailer.enabled).toBe(false);
    await expect(mailer.send({ to: 'a@b.c', subject: 's', html: 'h', text: 't' })).rejects.toMatchObject({
      status: 503,
      code: 'MAIL_DISABLED',
    });
    expect(sent).toHaveLength(0);
    await waitFor(() => true);
  });
});
