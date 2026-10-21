import { io as ioc, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  createChannel,
  register,
  sendMessage,
  startTestApp,
  waitFor,
  type TestApp,
} from './helpers.js';

let app: TestApp;
const sockets: Socket[] = [];

beforeAll(async () => {
  app = await startTestApp();
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await app.reset();
});
afterAll(() => app.stop());

function connect(token: string): Promise<{ socket: Socket; ready: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = ioc(app.baseUrl, {
      path: '/socket.io/',
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    sockets.push(socket);
    socket.once('ready', (ready) => resolve({ socket, ready }));
    socket.once('connect_error', (err) => reject(err));
  });
}

function emitAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<{ ok: boolean; data?: T; error?: { code: string } }> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function collect<T = unknown>(socket: Socket, event: string): T[] {
  const list: T[] = [];
  socket.on(event, (p: T) => list.push(p));
  return list;
}

describe('gateway', () => {
  it('rejects bad tokens with connect_error "unauthorized"', async () => {
    await expect(connect('bad.token.here')).rejects.toMatchObject({ message: 'unauthorized' });
  });

  it('sends ready with presences, broadcasts presence and user:create, relays typing', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const { socket: sa, ready } = await connect(a.token);
    expect(ready.sessionId).toBe(sa.id);
    expect((ready.user as { id: string; settings: unknown }).id).toBe(a.user.id);
    expect(ready.presences).toEqual({ [a.user.id]: 'online' });
    expect(ready.voiceStates).toEqual([]);

    const presence = collect<{ userId: string; presence: string }>(sa, 'presence:update');
    const created = collect<{ username: string }>(sa, 'user:create');
    const { socket: sb, ready: readyB } = await connect(b.token);
    expect(readyB.presences).toEqual({ [a.user.id]: 'online', [b.user.id]: 'online' });
    await waitFor(() => presence.find((p) => p.userId === b.user.id && p.presence === 'online'));

    const users = await app.api.get('/api/v1/users').set(auth(a.token)).expect(200);
    expect(users.body.users.find((u: { id: string }) => u.id === b.user.id).presence).toBe('online');

    await register(app, 'carol');
    await waitFor(() => created.find((u) => u.username === 'carol'));

    // status change → presence:update; invisible looks offline to others
    await app.api.patch('/api/v1/users/me').set(auth(b.token)).send({ status: 'invisible' }).expect(200);
    await waitFor(() => presence.find((p) => p.userId === b.user.id && p.presence === 'offline'));

    const ch = await createChannel(app, a.token, 'general');
    const typingA = collect(sa, 'typing');
    const typingB = collect<{ channelId: string; userId: string }>(sb, 'typing');
    const ack = await emitAck(sa, 'typing', { channelId: ch.id });
    expect(ack.ok).toBe(true);
    await waitFor(() => typingB.find((t) => t.userId === a.user.id && t.channelId === ch.id));
    expect(typingA).toHaveLength(0);

    sb.disconnect();
    await waitFor(() =>
      presence.filter((p) => p.userId === b.user.id && p.presence === 'offline').length >= 2
        ? true
        : undefined,
    );
  });

  it('delivers message events to everyone for text channels but only participants for DMs', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const c = await register(app, 'carol');
    const { socket: sb } = await connect(b.token);
    const { socket: sc } = await connect(c.token);
    const bMessages = collect<{ content: string }>(sb, 'message:create');
    const cMessages = collect<{ content: string }>(sc, 'message:create');

    const ch = await createChannel(app, a.token, 'general');
    await sendMessage(app, a.token, ch.id, 'public');
    const dm = (
      await app.api.post('/api/v1/channels/dm').set(auth(a.token)).send({ userId: b.user.id }).expect(201)
    ).body.channel;
    await sendMessage(app, a.token, dm.id, 'private');

    await waitFor(() => bMessages.find((m) => m.content === 'private'));
    await waitFor(() => cMessages.find((m) => m.content === 'public'));
    expect(bMessages.map((m) => m.content).sort()).toEqual(['private', 'public']);
    expect(cMessages.map((m) => m.content)).toEqual(['public']);
  });

  it('manages voice state, relays rtc signals only inside the channel and cleans up on disconnect', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bob');
    const c = await register(app, 'carol');
    const lounge = await createChannel(app, a.token, 'lounge', 'voice');
    const other = await createChannel(app, a.token, 'other', 'voice');
    const text = await createChannel(app, a.token, 'general');

    const { socket: sa } = await connect(a.token);
    const { socket: sb } = await connect(b.token);
    const { socket: sc } = await connect(c.token);
    const statesA = collect<{
      channelId: string;
      members: { socketId: string; muted: boolean; streaming: boolean }[];
    }>(sa, 'voice:state');

    const notVoice = await emitAck(sa, 'voice:join', { channelId: text.id });
    expect(notVoice).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    const joinA = await emitAck<{ channelId: string; members: { socketId: string }[] }>(sa, 'voice:join', {
      channelId: lounge.id,
    });
    expect(joinA.ok).toBe(true);
    expect(joinA.data?.members.map((m) => m.socketId)).toEqual([sa.id]);

    const joinB = await emitAck<{ members: { socketId: string; userId: string }[] }>(sb, 'voice:join', {
      channelId: lounge.id,
    });
    expect(joinB.data?.members.map((m) => m.socketId).sort()).toEqual([sa.id, sb.id].sort());
    await waitFor(() => statesA.find((s) => s.channelId === lounge.id && s.members.length === 2));

    // late joiner sees voice states in ready
    const { ready } = await connect(c.token);
    expect((ready.voiceStates as { channelId: string; members: unknown[] }[])[0]).toMatchObject({
      channelId: lounge.id,
    });
    expect((ready.voiceStates as { members: unknown[] }[])[0]?.members).toHaveLength(2);

    // signalling between members works, outsiders are refused
    const signalsB = collect<{ from: string; scope: string; type: string; payload: unknown }>(
      sb,
      'rtc:signal',
    );
    const relay = await emitAck(sa, 'rtc:signal', {
      to: sb.id,
      scope: 'voice',
      type: 'offer',
      payload: { sdp: 'x' },
    });
    expect(relay.ok).toBe(true);
    await waitFor(() => signalsB.find((s) => s.from === sa.id && s.type === 'offer'));
    expect(signalsB[0]).toMatchObject({ scope: 'voice', payload: { sdp: 'x' } });
    const refused = await emitAck(sc, 'rtc:signal', {
      to: sb.id,
      scope: 'voice',
      type: 'offer',
      payload: {},
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const toSelf = await emitAck(sa, 'rtc:signal', { to: sa.id, scope: 'voice', type: 'offer', payload: {} });
    expect(toSelf.ok).toBe(false);

    // screen share handshake
    const watchRequests = collect<{ from: string }>(sa, 'screen:watch');
    const notStreaming = await emitAck(sb, 'screen:watch', { to: sa.id });
    expect(notStreaming).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    const upd = await emitAck<{ members: { socketId: string; streaming: boolean; muted: boolean }[] }>(
      sa,
      'voice:update',
      { streaming: true, muted: true },
    );
    expect(upd.data?.members.find((m) => m.socketId === sa.id)).toMatchObject({
      streaming: true,
      muted: true,
      deafened: false,
    });
    const watch = await emitAck(sb, 'screen:watch', { to: sa.id });
    expect(watch.ok).toBe(true);
    await waitFor(() => watchRequests.find((w) => w.from === sb.id));
    const outsiderUpdate = await emitAck(sc, 'voice:update', { muted: true });
    expect(outsiderUpdate.ok).toBe(false);

    // switching channels leaves the old one
    const move = await emitAck(sb, 'voice:join', { channelId: other.id });
    expect(move.ok).toBe(true);
    await waitFor(() => statesA.find((s) => s.channelId === other.id && s.members.length === 1));
    await waitFor(() =>
      statesA
        .filter((s) => s.channelId === lounge.id)
        .find((s) => s.members.length === 1 && s.members[0]?.socketId === sa.id),
    );

    // explicit leave and disconnect both broadcast empty states
    const leave = await emitAck(sb, 'voice:leave', {});
    expect(leave.ok).toBe(true);
    await waitFor(() => statesA.find((s) => s.channelId === other.id && s.members.length === 0));
    const { socket: sb2 } = await connect(b.token);
    await emitAck(sb2, 'voice:join', { channelId: lounge.id });
    await waitFor(() => statesA.find((s) => s.channelId === lounge.id && s.members.length === 2));
    sb2.disconnect();
    await waitFor(() => {
      const last = statesA.filter((s) => s.channelId === lounge.id).at(-1);
      return last && last.members.length === 1 ? true : undefined;
    });

    // deleting a voice channel kicks everyone
    const deleted = collect<{ channelId: string }>(sa, 'channel:delete');
    await app.api.delete(`/api/v1/channels/${lounge.id}`).set(auth(a.token)).expect(204);
    await waitFor(() => deleted.find((d) => d.channelId === lounge.id));
    await waitFor(() => statesA.find((s) => s.channelId === lounge.id && s.members.length === 0));
  });
});
