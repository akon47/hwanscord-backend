import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auth, register, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterEach(() => app.reset());
afterAll(() => app.stop());

describe('users', () => {
  it('lists users with presence and hides settings of others', async () => {
    const a = await register(app, 'alice', 'Alice');
    const b = await register(app, 'bob', 'Bob');
    const res = await app.api.get('/api/v1/users').set(auth(a.token)).expect(200);
    expect(res.body.users).toHaveLength(2);
    const bob = res.body.users.find((u: { id: string }) => u.id === b.user.id);
    expect(bob.presence).toBe('offline');
    expect(bob.settings).toBeUndefined();
    const alice = res.body.users.find((u: { id: string }) => u.id === a.user.id);
    expect(alice.settings).toEqual({});
  });

  it('patches profile fields and rejects unknown keys', async () => {
    const a = await register(app, 'alice');
    const res = await app.api
      .patch('/api/v1/users/me')
      .set(auth(a.token))
      .send({
        displayName: '앨리스',
        aboutMe: '안녕',
        customStatus: '',
        status: 'dnd',
        settings: { theme: 'light' },
      })
      .expect(200);
    expect(res.body.user).toMatchObject({
      displayName: '앨리스',
      aboutMe: '안녕',
      customStatus: null,
      status: 'dnd',
    });
    expect(res.body.user.settings).toEqual({ theme: 'light' });
    await app.api.patch('/api/v1/users/me').set(auth(a.token)).send({ role: 'admin' }).expect(400);
    const other = await app.api.get(`/api/v1/users/${a.user.id}`).set(auth(a.token)).expect(200);
    expect(other.body.user.displayName).toBe('앨리스');
  });

  it('changes the password only with the correct current password', async () => {
    const a = await register(app, 'alice');
    await app.api
      .patch('/api/v1/users/me/password')
      .set(auth(a.token))
      .send({ currentPassword: 'wrong-wrong-wrong', newPassword: 'new-password-123' })
      .expect(401);
    await app.api
      .patch('/api/v1/users/me/password')
      .set(auth(a.token))
      .send({ currentPassword: 'alice-password-1', newPassword: 'new-password-123' })
      .expect(204);
    await app.api
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'new-password-123' })
      .expect(200);
  });

  it('uploads an avatar as 256x256 webp, replaces the old file and can delete it', async () => {
    const a = await register(app, 'alice');
    const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } })
      .png()
      .toBuffer();
    const first = await app.api
      .put('/api/v1/users/me/avatar')
      .set(auth(a.token))
      .attach('avatar', png, 'me.png')
      .expect(200);
    expect(first.body.user.avatarUrl).toMatch(/^\/uploads\/avatars\/[0-9a-f]{24}-[0-9a-f]{8}\.webp$/);
    const file = path.join(app.uploadDir, 'avatars', path.basename(first.body.user.avatarUrl));
    const meta = await sharp(await fs.readFile(file)).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([256, 256]);

    const served = await app.api.get(first.body.user.avatarUrl).expect(200);
    expect(served.headers['cache-control']).toContain('immutable');
    expect(served.headers['x-content-type-options']).toBe('nosniff');

    const png2 = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#00ff00' } })
      .png()
      .toBuffer();
    const second = await app.api
      .put('/api/v1/users/me/avatar')
      .set(auth(a.token))
      .attach('avatar', png2, 'me2.png')
      .expect(200);
    expect(second.body.user.avatarUrl).not.toBe(first.body.user.avatarUrl);
    await expect(fs.access(file)).rejects.toThrow();

    await app.api
      .put('/api/v1/users/me/avatar')
      .set(auth(a.token))
      .attach('avatar', Buffer.from('hello'), 'x.txt')
      .expect(415);

    const removed = await app.api.delete('/api/v1/users/me/avatar').set(auth(a.token)).expect(200);
    expect(removed.body.user.avatarUrl).toBeNull();
    const files = await fs.readdir(path.join(app.uploadDir, 'avatars'));
    expect(files).toHaveLength(0);
  });
});
