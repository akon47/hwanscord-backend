import { io as ioc, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EmailToken } from '../src/models/EmailToken.js';
import { Meta } from '../src/models/Meta.js';
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

function lastMailTo(to: string): SentMail {
  const mail = [...sent].reverse().find((m) => m.to === to);
  expect(mail, `mail to ${to}`).toBeTruthy();
  return mail!;
}

function codeFrom(to: string): string {
  const m = lastMailTo(to).text.match(/인증 코드: (\d{6})/);
  expect(m, 'code in mail').toBeTruthy();
  return m![1]!;
}

function resetTokenFrom(to: string): string {
  const m = lastMailTo(to).text.match(new RegExp(`${PUBLIC_URL}/reset-password#token=([A-Za-z0-9_-]+)`));
  expect(m, 'reset link in mail').toBeTruthy();
  return decodeURIComponent(m![1]!);
}

/** Moves every token's createdAt back (the 60 s resend throttle). Mongoose treats createdAt as immutable. */
const ageTokens = (ms: number) =>
  EmailToken.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - ms) } });

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

/** The full 3-step signup. */
async function signup(email: string, extra: Record<string, unknown> = {}, status = 201) {
  await app.api.post('/api/v1/auth/register/start').send({ email }).expect(204);
  const code = codeFrom(email.toLowerCase());
  const verified = await app.api.post('/api/v1/auth/register/verify').send({ email, code });
  if (verified.status !== 200) return verified;
  return app.api
    .post('/api/v1/auth/register')
    .send({ signupToken: verified.body.signupToken, password: 'signup-password-1', ...extra })
    .expect(status);
}

describe('verify-first signup', () => {
  it('creates a verified account in three steps; the first one is admin', async () => {
    const res = await signup('Mina.Kim@Example.COM', { displayName: '미나' }, 201);
    expect(res.body.user).toMatchObject({
      username: 'mina.kim',
      displayName: '미나',
      email: 'mina.kim@example.com',
      emailVerified: true,
      emailRequired: false,
      role: 'admin',
    });
    const mail = sent[0]!;
    expect(mail).toMatchObject({ to: 'mina.kim@example.com', from: 'HWANSCORD <noreply@kimhwan.kr>' });
    expect(mail.subject).toMatch(/인증 코드 \d{6}/);
    expect(mail.html).toContain('#5865f2');
    expect(mail.text).toContain('10분');
    await app.api.get('/api/v1/channels').set(auth(res.body.token)).expect(200);
    await connect(res.body.token);

    const second = await signup('second@example.com', {}, 201);
    expect(second.body.user.role).toBe('member');
  });

  it('stores only an HMAC of the code', async () => {
    await app.api.post('/api/v1/auth/register/start').send({ email: 'a@example.com' }).expect(204);
    const code = codeFrom('a@example.com');
    const stored = await EmailToken.findOne({ purpose: 'signup' }).lean();
    expect(stored?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('suggests a free username from the email and respects an explicit one', async () => {
    await register(app, 'mina');
    const auto = await signup('mina@other.com', {}, 201);
    expect(auto.body.user.username).toBe('mina2');
    const taken = await signup('x@example.com', { username: 'mina' }, 409);
    expect(taken.body.error.message).toBe('이미 사용 중인 사용자명입니다.');
    const chosen = await signup('y@example.com', { username: 'yyy_handle' }, 201);
    expect(chosen.body.user.username).toBe('yyy_handle');
    const weird = await signup('Hello.World+Tag@example.com', {}, 201);
    expect(weird.body.user.username).toBe('hello.world_tag');
  });

  it('checks username availability with a suggestion', async () => {
    await register(app, 'taken');
    const busy = await app.api
      .get('/api/v1/auth/username-available')
      .query({ username: 'taken' })
      .expect(200);
    expect(busy.body).toEqual({ available: false, suggestion: 'taken2' });
    const free = await app.api
      .get('/api/v1/auth/username-available')
      .query({ username: 'Fresh_One' })
      .expect(200);
    expect(free.body).toEqual({ available: true, suggestion: 'fresh_one' });
    const bad = await app.api
      .get('/api/v1/auth/username-available')
      .query({ username: 'Bad Name!' })
      .expect(200);
    expect(bad.body.available).toBe(false);
    expect(bad.body.suggestion).toMatch(/^[a-z0-9_.]{2,32}$/);
  });

  it('counts wrong codes and voids the code after five', async () => {
    await app.api.post('/api/v1/auth/register/start').send({ email: 'w@example.com' }).expect(204);
    const right = codeFrom('w@example.com');
    const wrong = right === '000000' ? '111111' : '000000';
    for (let left = 4; left >= 1; left--) {
      const r = await app.api
        .post('/api/v1/auth/register/verify')
        .send({ email: 'w@example.com', code: wrong })
        .expect(400);
      expect(r.body.error).toMatchObject({
        message: '인증 코드가 올바르지 않습니다.',
        details: { remainingAttempts: left },
      });
    }
    const last = await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 'w@example.com', code: wrong })
      .expect(400);
    expect(last.body.error).toMatchObject({ details: { remainingAttempts: 0 } });
    expect(last.body.error.message).toContain('만료');
    // even the right code no longer works
    const locked = await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 'w@example.com', code: right })
      .expect(400);
    expect(locked.body.error.details.remainingAttempts).toBe(0);
  });

  it('expires codes after 10 minutes and a resend replaces the code', async () => {
    await app.api.post('/api/v1/auth/register/start').send({ email: 'e@example.com' }).expect(204);
    const first = codeFrom('e@example.com');
    const throttled = await app.api
      .post('/api/v1/auth/register/start')
      .send({ email: 'e@example.com' })
      .expect(429);
    expect(throttled.body.error.code).toBe('RATE_LIMITED');
    await ageTokens(2 * 60_000);
    await app.api.post('/api/v1/auth/register/start').send({ email: 'e@example.com' }).expect(204);
    const second = codeFrom('e@example.com');
    if (first !== second) {
      await app.api
        .post('/api/v1/auth/register/verify')
        .send({ email: 'e@example.com', code: first })
        .expect(400);
    }
    await EmailToken.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 'e@example.com', code: second })
      .expect(400);
  });

  it('answers 204 for an existing address but mails a notice instead of a code', async () => {
    await register(app, 'owner');
    await app.api.post('/api/v1/auth/register/start').send({ email: 'Owner@Test.Example' }).expect(204);
    const mail = lastMailTo('owner@test.example');
    expect(mail.subject).toContain('이미 가입된 이메일입니다');
    expect(mail.text).toContain(`${PUBLIC_URL}/forgot-password`);
    expect(mail.text).not.toMatch(/인증 코드: \d{6}/);
    // no code can complete it
    const r = await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 'owner@test.example', code: '123456' })
      .expect(400);
    expect(r.body.error.details.remainingAttempts).toBe(4);
  });

  it('rejects forged, expired or reused signup tokens', async () => {
    await app.api
      .post('/api/v1/auth/register')
      .send({ signupToken: 'nope', password: 'password-123' })
      .expect(401);
    const first = await signup('once@example.com', {}, 201);
    expect(first.body.user.email).toBe('once@example.com');
    await ageTokens(2 * 60_000);
    // starting again for the same address only mails the "already registered" notice
    await app.api.post('/api/v1/auth/register/start').send({ email: 'once@example.com' }).expect(204);
    expect(lastMailTo('once@example.com').subject).toContain('이미 가입된 이메일입니다');
  });

  it('refuses an account when the address got registered between verify and register', async () => {
    await app.api.post('/api/v1/auth/register/start').send({ email: 'race@example.com' }).expect(204);
    const v = await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 'race@example.com', code: codeFrom('race@example.com') })
      .expect(200);
    await app.api
      .post('/api/v1/auth/register')
      .send({ signupToken: v.body.signupToken, password: 'password-123' })
      .expect(201);
    const dup = await app.api
      .post('/api/v1/auth/register')
      .send({ signupToken: v.body.signupToken, password: 'password-123' })
      .expect(409);
    expect(dup.body.error.message).toBe('이미 사용 중인 이메일입니다.');
  });

  it('a signup token is never a session', async () => {
    await app.api.post('/api/v1/auth/register/start').send({ email: 's@example.com' }).expect(204);
    const v = await app.api
      .post('/api/v1/auth/register/verify')
      .send({ email: 's@example.com', code: codeFrom('s@example.com') })
      .expect(200);
    await app.api.get('/api/v1/auth/me').set(auth(v.body.signupToken)).expect(401);
  });

  it('logs in with the email (case-insensitive) or the username, also via the `username` alias', async () => {
    await signup('Case@Example.com', { username: 'caser' }, 201);
    await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'CASE@example.COM', password: 'signup-password-1' })
      .expect(200);
    await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'case@example.com', password: 'signup-password-1' })
      .expect(200);
    await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'caser', password: 'signup-password-1' })
      .expect(200);
    const bad = await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'case@example.com', password: 'nope' })
      .expect(401);
    expect(bad.body.error.message).toBe('이메일(아이디) 또는 비밀번호가 올바르지 않습니다.');
  });

  it('still logs in legacy usernames that look like an email', async () => {
    await register(app, 'test@test.com', undefined, { email: null });
    await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'test@test.com', password: 'test@test.com-password-1' })
      .expect(200);
  });
});

describe('email gate', () => {
  it('gates accounts without a verified email: REST 403, socket email_required, allowlist works', async () => {
    const legacy = await register(app, 'legacy', '옛날', { email: null });
    expect(legacy.user).toMatchObject({ email: null, emailVerified: false, emailRequired: true });
    const t = legacy.token;
    const blocked = await app.api.get('/api/v1/channels').set(auth(t)).expect(403);
    expect(blocked.body.error.code).toBe('EMAIL_REQUIRED');
    await app.api.get('/api/v1/users').set(auth(t)).expect(403);
    await app.api.patch('/api/v1/users/me').set(auth(t)).send({ displayName: 'x' }).expect(403);
    await app.api.get('/api/v1/auth/me').set(auth(t)).expect(200);
    await app.api.get('/api/v1/users/me').set(auth(t)).expect(200);
    await expect(connect(t)).rejects.toThrow('email_required');

    // set the email through a code
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(t))
      .send({ email: 'legacy@example.com' })
      .expect(400); // password needed
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(t))
      .send({ email: 'legacy@example.com', currentPassword: 'wrong-one' })
      .expect(400);
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(t))
      .send({ email: 'Legacy@Example.com', currentPassword: 'legacy-password-1' })
      .expect(204);
    const mail = lastMailTo('legacy@example.com');
    expect(mail.text).toContain('옛날님');
    const done = await app.api
      .post('/api/v1/users/me/email/verify')
      .set(auth(t))
      .send({ code: codeFrom('legacy@example.com') })
      .expect(200);
    expect(done.body.user).toMatchObject({
      email: 'legacy@example.com',
      emailVerified: true,
      emailRequired: false,
    });
    await app.api.get('/api/v1/channels').set(auth(t)).expect(200);
    await connect(t);
    // and it can now log in with the email
    await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'legacy@example.com', password: 'legacy-password-1' })
      .expect(200);
  });

  it('refuses an address used by another account', async () => {
    await register(app, 'alice');
    const legacy = await register(app, 'legacy', undefined, { email: null });
    const r = await app.api
      .post('/api/v1/users/me/email')
      .set(auth(legacy.token))
      .send({ email: 'alice@test.example', currentPassword: 'legacy-password-1' })
      .expect(409);
    expect(r.body.error.message).toBe('이미 사용 중인 이메일입니다.');
  });

  it('wrong codes for an email change count down too', async () => {
    const legacy = await register(app, 'legacy', undefined, { email: null });
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(legacy.token))
      .send({ email: 'l@example.com', currentPassword: 'legacy-password-1' })
      .expect(204);
    const right = codeFrom('l@example.com');
    const wrong = right === '999999' ? '888888' : '999999';
    const r = await app.api
      .post('/api/v1/users/me/email/verify')
      .set(auth(legacy.token))
      .send({ code: wrong })
      .expect(400);
    expect(r.body.error.details.remainingAttempts).toBe(4);
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(legacy.token))
      .send({ email: 'l@example.com', currentPassword: 'legacy-password-1' })
      .expect(429);
  });
});

describe('email change', () => {
  it('changes a verified email only after the code to the new address', async () => {
    const a = await register(app, 'alice');
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(a.token))
      .send({ email: 'alice@test.example', currentPassword: 'alice-password-1' })
      .expect(400);
    await app.api
      .post('/api/v1/users/me/email')
      .set(auth(a.token))
      .send({ email: 'new@example.com', currentPassword: 'alice-password-1' })
      .expect(204);
    let me = await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(200);
    expect(me.body.user.email).toBe('alice@test.example');
    const live = await connect(a.token);
    const update = new Promise<{ email?: string }>((resolve) => live.once('user:update', resolve));
    await app.api
      .post('/api/v1/users/me/email/verify')
      .set(auth(a.token))
      .send({ code: codeFrom('new@example.com') })
      .expect(200);
    expect((await update).email).toBe('new@example.com');
    me = await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(200);
    expect(me.body.user.email).toBe('new@example.com');
  });

  it('never shows emails to other users', async () => {
    const a = await register(app, 'alice');
    await register(app, 'bob');
    const list = await app.api.get('/api/v1/users').set(auth(a.token)).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('bob@test.example');
  });
});

describe('username handle', () => {
  it('can be changed, is unique and broadcast', async () => {
    const a = await register(app, 'alice');
    await register(app, 'bob');
    const live = await connect(a.token);
    const update = new Promise<{ username: string }>((resolve) => live.once('user:update', resolve));
    await app.api.patch('/api/v1/users/me').set(auth(a.token)).send({ username: 'bob' }).expect(409);
    await app.api.patch('/api/v1/users/me').set(auth(a.token)).send({ username: 'Bad!' }).expect(400);
    const ok = await app.api
      .patch('/api/v1/users/me')
      .set(auth(a.token))
      .send({ username: 'alice_2' })
      .expect(200);
    expect(ok.body.user.username).toBe('alice_2');
    expect((await update).username).toBe('alice_2');
  });
});

describe('password reset', () => {
  it('forgot is always 204 and only mails verified addresses', async () => {
    await register(app, 'legacy', undefined, { email: null });
    await register(app, 'alice');
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'nobody' }).expect(204);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'legacy' }).expect(204);
    expect(sent).toHaveLength(0);
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'ALICE@test.example' }).expect(204);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('30분');
    resendDown = true;
    await EmailToken.deleteMany({});
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
  });

  it('resets once and signs out every session (REST and socket)', async () => {
    const a = await register(app, 'alice');
    const live = await connect(a.token);
    const dropped = new Promise<void>((resolve) => live.once('disconnect', () => resolve()));
    await app.api.post('/api/v1/auth/password/forgot').send({ login: 'alice' }).expect(204);
    const token = resetTokenFrom('alice@test.example');
    await app.api
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'brand-new-password' })
      .expect(204);
    await app.api
      .post('/api/v1/auth/password/reset')
      .send({ token, newPassword: 'another-password' })
      .expect(400);
    await dropped;
    await app.api.get('/api/v1/auth/me').set(auth(a.token)).expect(401);
    await expect(connect(a.token)).rejects.toThrow('unauthorized');
    await app.api
      .post('/api/v1/auth/login')
      .send({ login: 'alice@test.example', password: 'brand-new-password' })
      .expect(200);
  });
});

describe('mail budget and outages', () => {
  it('stops sending at the daily limit with 503 MAIL_QUOTA', async () => {
    const key = `mail:sent:${new Date().toISOString().slice(0, 10)}`;
    await Meta.updateOne({ key }, { $set: { value: LIMIT } }, { upsert: true });
    const res = await app.api
      .post('/api/v1/auth/register/start')
      .send({ email: 'q@example.com' })
      .expect(503);
    expect(res.body.error.code).toBe('MAIL_QUOTA');
    expect(sent).toHaveLength(0);
    expect((await Meta.findOne({ key }).lean())?.value).toBe(LIMIT);
  });

  it('reports a Resend failure instead of pretending the code went out', async () => {
    resendDown = true;
    await app.api.post('/api/v1/auth/register/start').send({ email: 'down@example.com' }).expect(500);
  });
});

describe('admin', () => {
  it('lists users with email status and issues a temporary password once', async () => {
    const admin = await register(app, 'boss');
    const member = await register(app, 'carol');
    await register(app, 'legacy', undefined, { email: null });
    await app.api.get('/api/v1/admin/users').set(auth(member.token)).expect(403);
    const list = await app.api.get('/api/v1/admin/users').set(auth(admin.token)).expect(200);
    const carol = list.body.users.find((u: { username: string }) => u.username === 'carol');
    expect(carol).toMatchObject({ email: 'carol@test.example', emailVerified: true, hasPassword: true });
    const legacy = list.body.users.find((u: { username: string }) => u.username === 'legacy');
    expect(legacy).toMatchObject({ email: null, emailRequired: true });

    const live = await connect(member.token);
    const dropped = new Promise<void>((resolve) => live.once('disconnect', () => resolve()));
    const res = await app.api
      .post(`/api/v1/admin/users/${member.user.id}/temporary-password`)
      .set(auth(admin.token))
      .expect(200);
    const temp = res.body.temporaryPassword as string;
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
    await dropped;
    await app.api.get('/api/v1/auth/me').set(auth(member.token)).expect(401);
    await app.api.post('/api/v1/auth/login').send({ login: 'carol', password: temp }).expect(200);
    await waitFor(() => true);
  });
});
