import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auth, createChannel, register, sendMessage, startTestApp, type TestApp } from './helpers.js';

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterEach(() => app.reset());
afterAll(() => app.stop());

describe('messages', () => {
  it('paginates with before/after cursors in ascending order', async () => {
    const a = await register(app, 'alice');
    const ch = await createChannel(app, a.token, 'general');
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) ids.push((await sendMessage(app, a.token, ch.id, `msg ${i}`)).id);

    const latest = await app.api
      .get(`/api/v1/channels/${ch.id}/messages?limit=3`)
      .set(auth(a.token))
      .expect(200);
    expect(latest.body.messages.map((m: { content: string }) => m.content)).toEqual([
      'msg 4',
      'msg 5',
      'msg 6',
    ]);
    expect(latest.body.hasMore).toBe(true);

    const before = await app.api
      .get(`/api/v1/channels/${ch.id}/messages?limit=3&before=${latest.body.messages[0].id}`)
      .set(auth(a.token))
      .expect(200);
    expect(before.body.messages.map((m: { content: string }) => m.content)).toEqual([
      'msg 1',
      'msg 2',
      'msg 3',
    ]);

    const first = await app.api
      .get(`/api/v1/channels/${ch.id}/messages?limit=3&before=${before.body.messages[0].id}`)
      .set(auth(a.token))
      .expect(200);
    expect(first.body.messages.map((m: { content: string }) => m.content)).toEqual(['msg 0']);
    expect(first.body.hasMore).toBe(false);

    const after = await app.api
      .get(`/api/v1/channels/${ch.id}/messages?limit=2&after=${ids[4]}`)
      .set(auth(a.token))
      .expect(200);
    expect(after.body.messages.map((m: { content: string }) => m.content)).toEqual(['msg 5', 'msg 6']);
    expect(after.body.hasMore).toBe(false);

    await app.api
      .get(`/api/v1/channels/${ch.id}/messages?before=${ids[1]}&after=${ids[0]}`)
      .set(auth(a.token))
      .expect(400);
  });

  it('parses mentions, echoes nonce, supports replies and reports deleted originals', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const ch = await createChannel(app, a.token, 'general');
    const fakeId = '0123456789abcdef01234567';
    const m1 = await sendMessage(app, a.token, ch.id, `hi <@${b.user.id}> and <@${fakeId}> @everyone`, {
      nonce: 'n-1',
    });
    expect(m1.mentions).toEqual([b.user.id]);
    expect(m1.mentionEveryone).toBe(true);
    expect(m1.nonce).toBe('n-1');
    expect(m1.author).toMatchObject({ id: a.user.id, username: 'alice' });

    const reply = await sendMessage(app, b.token, ch.id, 'reply', { replyTo: m1.id });
    expect(reply.replyTo).toMatchObject({
      id: m1.id,
      content: expect.stringContaining('hi'),
      deleted: false,
    });
    expect((reply.replyTo as { author: { id: string } }).author.id).toBe(a.user.id);

    await app.api
      .post(`/api/v1/channels/${ch.id}/messages`)
      .set(auth(a.token))
      .send({ content: 'x', replyTo: fakeId })
      .expect(400);

    await app.api.delete(`/api/v1/channels/${ch.id}/messages/${m1.id}`).set(auth(a.token)).expect(204);
    const list = await app.api.get(`/api/v1/channels/${ch.id}/messages`).set(auth(a.token)).expect(200);
    expect(list.body.messages).toHaveLength(1);
    expect(list.body.messages[0].replyTo).toEqual({ id: m1.id, author: null, content: '', deleted: true });
  });

  it('edits only own messages and deletes as author or admin', async () => {
    const admin = await register(app, 'admin');
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const ch = await createChannel(app, a.token, 'general');
    const m = await sendMessage(app, a.token, ch.id, 'original');
    await app.api
      .patch(`/api/v1/channels/${ch.id}/messages/${m.id}`)
      .set(auth(b.token))
      .send({ content: 'hack' })
      .expect(403);
    const edited = await app.api
      .patch(`/api/v1/channels/${ch.id}/messages/${m.id}`)
      .set(auth(a.token))
      .send({ content: `edited <@${b.user.id}>` })
      .expect(200);
    expect(edited.body.message.editedAt).not.toBeNull();
    expect(edited.body.message.mentions).toEqual([b.user.id]);
    await app.api.delete(`/api/v1/channels/${ch.id}/messages/${m.id}`).set(auth(b.token)).expect(403);
    await app.api.delete(`/api/v1/channels/${ch.id}/messages/${m.id}`).set(auth(admin.token)).expect(204);
    await app.api.delete(`/api/v1/channels/${ch.id}/messages/${m.id}`).set(auth(admin.token)).expect(404);
  });

  it('binds uploaded attachments once, serves them with safe headers and validates content/attachments', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const ch = await createChannel(app, a.token, 'general');
    const png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#0000ff' } })
      .png()
      .toBuffer();
    const img = await app.api
      .post('/api/v1/attachments')
      .set(auth(a.token))
      .attach('file', png, '사진.png')
      .expect(201);
    expect(img.body.attachment).toMatchObject({
      filename: '사진.png',
      contentType: 'image/png',
      width: 12,
      height: 8,
    });
    const doc = await app.api
      .post('/api/v1/attachments')
      .set(auth(a.token))
      .attach('file', Buffer.from('%PDF-1.4'), 'doc.pdf')
      .expect(201);
    const bin = await app.api
      .post('/api/v1/attachments')
      .set(auth(a.token))
      .attach('file', Buffer.from('MZ'), 'tool.exe')
      .expect(201);

    await app.api
      .post(`/api/v1/channels/${ch.id}/messages`)
      .set(auth(a.token))
      .send({ content: '   ' })
      .expect(400);
    // someone else's upload cannot be attached
    await app.api
      .post(`/api/v1/channels/${ch.id}/messages`)
      .set(auth(b.token))
      .send({ content: 'steal', attachmentIds: [img.body.attachment.id] })
      .expect(400);

    const msg = await sendMessage(app, a.token, ch.id, '', {
      attachmentIds: [img.body.attachment.id, doc.body.attachment.id, bin.body.attachment.id],
    });
    expect(msg.attachments).toHaveLength(3);
    // cannot be attached twice
    await app.api
      .post(`/api/v1/channels/${ch.id}/messages`)
      .set(auth(a.token))
      .send({ content: 'again', attachmentIds: [img.body.attachment.id] })
      .expect(400);

    const served = await app.api.get(img.body.attachment.url).expect(200);
    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['content-disposition']).toBe('inline');
    expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const servedBin = await app.api.get(bin.body.attachment.url).expect(200);
    expect(servedBin.headers['content-disposition']).toBe('attachment');
    expect(servedBin.headers['x-content-type-options']).toBe('nosniff');

    await app.api.delete(`/api/v1/channels/${ch.id}/messages/${msg.id}`).set(auth(a.token)).expect(204);
    const files = await fs.readdir(path.join(app.uploadDir, 'attachments'));
    expect(files).toHaveLength(0);
  });

  it('toggles reactions and validates emoji', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const ch = await createChannel(app, a.token, 'general');
    const m = await sendMessage(app, a.token, ch.id, 'react to me');
    const thumbs = encodeURIComponent('👍');
    let res = await app.api
      .put(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${thumbs}`)
      .set(auth(a.token))
      .expect(200);
    res = await app.api
      .put(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${thumbs}`)
      .set(auth(b.token))
      .expect(200);
    res = await app.api
      .put(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${thumbs}`)
      .set(auth(b.token))
      .expect(200);
    expect(res.body.message.reactions).toEqual([
      { emoji: '👍', count: 2, userIds: expect.arrayContaining([a.user.id, b.user.id]) },
    ]);
    res = await app.api
      .put(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${encodeURIComponent('🇰🇷')}`)
      .set(auth(a.token))
      .expect(200);
    expect(res.body.message.reactions).toHaveLength(2);
    await app.api
      .put(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/abc`)
      .set(auth(a.token))
      .expect(400);
    res = await app.api
      .delete(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${thumbs}`)
      .set(auth(a.token))
      .expect(200);
    res = await app.api
      .delete(`/api/v1/channels/${ch.id}/messages/${m.id}/reactions/${thumbs}`)
      .set(auth(b.token))
      .expect(200);
    expect(res.body.message.reactions).toEqual([{ emoji: '🇰🇷', count: 1, userIds: [a.user.id] }]);
  });

  it('pins and unpins messages', async () => {
    const a = await register(app, 'alice');
    const ch = await createChannel(app, a.token, 'general');
    const m1 = await sendMessage(app, a.token, ch.id, 'one');
    const m2 = await sendMessage(app, a.token, ch.id, 'two');
    await app.api.put(`/api/v1/channels/${ch.id}/pins/${m1.id}`).set(auth(a.token)).expect(200);
    const pinned = await app.api
      .put(`/api/v1/channels/${ch.id}/pins/${m2.id}`)
      .set(auth(a.token))
      .expect(200);
    expect(pinned.body.message.pinned).toBe(true);
    const list = await app.api.get(`/api/v1/channels/${ch.id}/pins`).set(auth(a.token)).expect(200);
    expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([m2.id, m1.id]);
    await app.api.delete(`/api/v1/channels/${ch.id}/pins/${m1.id}`).set(auth(a.token)).expect(200);
    const after = await app.api.get(`/api/v1/channels/${ch.id}/pins`).set(auth(a.token)).expect(200);
    expect(after.body.messages).toHaveLength(1);
  });

  it('searches messages with the text index, respecting DM visibility', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const c = await register(app, 'carol');
    const ch = await createChannel(app, a.token, 'general');
    await sendMessage(app, a.token, ch.id, 'deploy finished successfully');
    await sendMessage(app, b.token, ch.id, 'lunch?');
    await sendMessage(app, a.token, ch.id, 'another deploy tonight');
    const dm = (
      await app.api.post('/api/v1/channels/dm').set(auth(a.token)).send({ userId: b.user.id }).expect(201)
    ).body.channel;
    await sendMessage(app, a.token, dm.id, 'private deploy notes');

    const all = await app.api.get('/api/v1/messages/search?q=deploy').set(auth(a.token)).expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.results[0].content).toBe('private deploy notes');
    const carol = await app.api.get('/api/v1/messages/search?q=deploy').set(auth(c.token)).expect(200);
    expect(carol.body.total).toBe(2);
    const byAuthor = await app.api
      .get(`/api/v1/messages/search?q=deploy&channelId=${ch.id}&authorId=${a.user.id}&limit=1`)
      .set(auth(a.token))
      .expect(200);
    expect(byAuthor.body.total).toBe(2);
    expect(byAuthor.body.results).toHaveLength(1);
    await app.api.get(`/api/v1/messages/search?q=deploy&channelId=${dm.id}`).set(auth(c.token)).expect(404);
  });

  it('tracks read states, unread and mention counts, and acks', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const ch = await createChannel(app, a.token, 'general');
    const dm = (
      await app.api.post('/api/v1/channels/dm').set(auth(a.token)).send({ userId: b.user.id }).expect(201)
    ).body.channel;

    await sendMessage(app, a.token, ch.id, 'hello');
    const mention = await sendMessage(app, a.token, ch.id, `<@${b.user.id}> look`);
    await sendMessage(app, a.token, ch.id, '@everyone meeting');
    await sendMessage(app, b.token, ch.id, 'my own message does not count');
    await sendMessage(app, a.token, dm.id, 'dm 1');
    await sendMessage(app, a.token, dm.id, 'dm 2');

    const states = await app.api.get('/api/v1/read-states').set(auth(b.token)).expect(200);
    const forChannel = states.body.readStates.find((s: { channelId: string }) => s.channelId === ch.id);
    const forDm = states.body.readStates.find((s: { channelId: string }) => s.channelId === dm.id);
    expect(forChannel).toEqual({
      channelId: ch.id,
      lastReadMessageId: null,
      unreadCount: 3,
      mentionCount: 2,
    });
    expect(forDm).toEqual({ channelId: dm.id, lastReadMessageId: null, unreadCount: 2, mentionCount: 2 });

    const ack = await app.api
      .post(`/api/v1/channels/${ch.id}/ack`)
      .set(auth(b.token))
      .send({ messageId: mention.id })
      .expect(200);
    expect(ack.body.readState).toEqual({
      channelId: ch.id,
      lastReadMessageId: mention.id,
      unreadCount: 1,
      mentionCount: 1,
    });
    // acking an older message does not move the pointer back
    const older = (
      await app.api.get(`/api/v1/channels/${ch.id}/messages?limit=1&before=${mention.id}`).set(auth(b.token))
    ).body.messages[0];
    const again = await app.api
      .post(`/api/v1/channels/${ch.id}/ack`)
      .set(auth(b.token))
      .send({ messageId: older.id })
      .expect(200);
    expect(again.body.readState.lastReadMessageId).toBe(mention.id);
    await app.api
      .post(`/api/v1/channels/${ch.id}/ack`)
      .set(auth(b.token))
      .send({ messageId: '0123456789abcdef01234567' })
      .expect(404);
  });
});
