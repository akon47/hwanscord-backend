import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Attachment } from '../src/models/Attachment.js';
import { Message } from '../src/models/Message.js';
import { auth, createChannel, register, sendMessage, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterEach(() => app.reset());
afterAll(() => app.stop());

describe('channels', () => {
  it('creates, lists, updates and deletes channels with creator/admin permissions', async () => {
    const admin = await register(app, 'admin');
    const user = await register(app, 'user');
    const other = await register(app, 'other');

    const general = await createChannel(app, user.token, 'general');
    const voice = await createChannel(app, user.token, 'lounge', 'voice');
    expect(general.type).toBe('text');
    expect(voice.type).toBe('voice');

    await app.api
      .post('/api/v1/channels')
      .set(auth(user.token))
      .send({ type: 'text', name: 'general' })
      .expect(409);
    await app.api
      .post('/api/v1/channels')
      .set(auth(user.token))
      .send({ type: 'voice', name: 'general' })
      .expect(201);

    const list = await app.api.get('/api/v1/channels').set(auth(other.token)).expect(200);
    expect(list.body.channels.map((c: { name: string }) => c.name).sort()).toEqual([
      'general',
      'general',
      'lounge',
    ]);

    await app.api
      .patch(`/api/v1/channels/${general.id}`)
      .set(auth(other.token))
      .send({ topic: 'x' })
      .expect(403);
    const patched = await app.api
      .patch(`/api/v1/channels/${general.id}`)
      .set(auth(user.token))
      .send({ topic: '잡담', name: 'general-2' })
      .expect(200);
    expect(patched.body.channel).toMatchObject({ name: 'general-2', topic: '잡담' });

    await app.api.delete(`/api/v1/channels/${general.id}`).set(auth(other.token)).expect(403);
    await app.api.delete(`/api/v1/channels/${general.id}`).set(auth(admin.token)).expect(204);
    await app.api.delete(`/api/v1/channels/${voice.id}`).set(auth(user.token)).expect(204);
    const after = await app.api.get('/api/v1/channels').set(auth(user.token)).expect(200);
    expect(after.body.channels).toHaveLength(1);
  });

  it('cascades channel deletion to messages and attachments', async () => {
    const user = await register(app, 'user');
    const ch = await createChannel(app, user.token, 'temp');
    const up = await app.api
      .post('/api/v1/attachments')
      .set(auth(user.token))
      .attach('file', Buffer.from('data'), 'a.txt')
      .expect(201);
    await sendMessage(app, user.token, ch.id, 'with file', { attachmentIds: [up.body.attachment.id] });
    await sendMessage(app, user.token, ch.id, 'plain');
    await app.api.delete(`/api/v1/channels/${ch.id}`).set(auth(user.token)).expect(204);
    expect(await Message.countDocuments()).toBe(0);
    expect(await Attachment.countDocuments()).toBe(0);
    await app.api.get(up.body.attachment.url).expect(404);
  });

  it('get-or-creates DM channels visible only to participants', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const c = await register(app, 'carol');

    const created = await app.api
      .post('/api/v1/channels/dm')
      .set(auth(a.token))
      .send({ userId: b.user.id })
      .expect(201);
    expect(created.body.channel.type).toBe('dm');
    expect(created.body.channel.participants.sort()).toEqual([a.user.id, b.user.id].sort());
    const again = await app.api
      .post('/api/v1/channels/dm')
      .set(auth(b.token))
      .send({ userId: a.user.id })
      .expect(200);
    expect(again.body.channel.id).toBe(created.body.channel.id);
    await app.api.post('/api/v1/channels/dm').set(auth(a.token)).send({ userId: a.user.id }).expect(400);

    const dmId = created.body.channel.id;
    await sendMessage(app, a.token, dmId, 'secret');
    await app.api.get(`/api/v1/channels/${dmId}/messages`).set(auth(b.token)).expect(200);
    await app.api.get(`/api/v1/channels/${dmId}/messages`).set(auth(c.token)).expect(404);
    const carolList = await app.api.get('/api/v1/channels').set(auth(c.token)).expect(200);
    expect(carolList.body.channels.find((ch: { id: string }) => ch.id === dmId)).toBeUndefined();
    await app.api.patch(`/api/v1/channels/${dmId}`).set(auth(a.token)).send({ name: 'x' }).expect(400);
  });

  it('refuses messages in voice channels', async () => {
    const a = await register(app, 'alice');
    const voice = await createChannel(app, a.token, 'lounge', 'voice');
    await app.api
      .post(`/api/v1/channels/${voice.id}/messages`)
      .set(auth(a.token))
      .send({ content: 'hi' })
      .expect(400);
  });
});
