import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { User } from '../src/models/User.js';
import { auth, register, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterEach(() => app.reset());
afterAll(() => app.stop());

describe('auth', () => {
  it('registers the first user as admin and later users as members', async () => {
    const first = await register(app, 'first');
    expect(first.user.role).toBe('admin');
    expect(first.token.split('.')).toHaveLength(3);
    const second = await register(app, 'second', '둘째');
    expect(second.user.role).toBe('member');
    expect(second.user.displayName).toBe('둘째');
  });

  it('logs in and returns the same generic message for unknown user and wrong password', async () => {
    await register(app, 'loginuser');
    const ok = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'loginuser', password: 'loginuser-password-1' })
      .expect(200);
    expect(ok.body.user.username).toBe('loginuser');
    expect(ok.body.user.settings).toEqual({});
    const wrong = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'loginuser', password: 'nope-nope-nope' })
      .expect(401);
    const unknown = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'ghost', password: 'nope-nope-nope' })
      .expect(401);
    expect(wrong.body.error.message).toBe('이메일(아이디) 또는 비밀번호가 올바르지 않습니다.');
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('accepts legacy v1 accounts (bcrypt $2b$ hash in `password`, short password) and migrates the hash', async () => {
    const legacyHash = await bcrypt.hash('abc', 10); // v1 allowed any length
    await User.collection.insertOne({
      username: 'Legacy User',
      password: legacyHash,
      insertedDate: new Date('2021-01-01'),
    });
    const res = await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'Legacy User', password: 'abc' })
      .expect(200);
    expect(res.body.user.username).toBe('Legacy User');
    const stored = await User.collection.findOne({ username: 'Legacy User' });
    expect(stored?.passwordHash).toBe(legacyHash);
    expect(stored?.password).toBeUndefined();
    const me = await app.api.get('/api/v1/auth/me').set(auth(res.body.token)).expect(200);
    expect(me.body.user.displayName).toBe('Legacy User');
    // no verified email yet: the account is gated
    expect(me.body.user.emailRequired).toBe(true);
    const gated = await app.api.get('/api/v1/channels').set(auth(res.body.token)).expect(403);
    expect(gated.body.error.code).toBe('EMAIL_REQUIRED');
  });

  it('protects routes and reports 401 for missing or bad tokens', async () => {
    await app.api.get('/api/v1/channels').expect(401);
    const res = await app.api
      .get('/api/v1/channels')
      .set({ Authorization: 'Bearer not.a.token' })
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('serves /healthz', async () => {
    const res = await app.api.get('/healthz').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', mongo: 'connected' });
    expect(typeof res.body.uptime).toBe('number');
  });
});
