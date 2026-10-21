import type { DefaultEventsMap, Server, Socket } from 'socket.io';

import { z, type ZodTypeAny } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError } from '../lib/errors.js';
import { toUser, type Presence } from '../lib/serialize.js';
import { toApiError } from '../http/middleware/errors.js';
import { Channel, type IChannel } from '../models/Channel.js';
import { User, type IUser } from '../models/User.js';
import { extractBearer, verifyToken } from '../services/auth.js';
import { canSee } from '../services/channels.js';

export interface SocketData {
  user: IUser;
  typingAt: Map<string, number>;
}

export type AppServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
export type AppSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

type AckResponse = { ok: true; data?: unknown } | { ok: false; error: { code: string; message: string } };
type Ack = (res: AckResponse) => void;

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, '잘못된 식별자입니다.');
const socketId = z.string().min(1).max(64);

const typingSchema = z.object({ channelId: objectId });
const voiceJoinSchema = z.object({ channelId: objectId });
const emptySchema = z.object({}).passthrough();
const voiceUpdateSchema = z
  .object({
    muted: z.boolean().optional(),
    deafened: z.boolean().optional(),
    streaming: z.boolean().optional(),
  })
  .strict();
const signalSchema = z.object({
  to: socketId,
  scope: z.enum(['voice', 'screen']),
  type: z.enum(['offer', 'answer', 'candidate']),
  payload: z.unknown(),
});
const targetSchema = z.object({ to: socketId });

const TYPING_INTERVAL_MS = 2000;
const MAX_SIGNAL_BYTES = 128 * 1024;

export function registerGateway(io: AppServer, ctx: AppContext): void {
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth as { token?: unknown } | undefined;
      const raw =
        typeof auth?.token === 'string' ? auth.token : extractBearer(socket.handshake.headers.authorization);
      if (!raw) throw ApiError.unauthorized();
      const payload = verifyToken(ctx.config, raw);
      const user = await User.findById(payload.sub).lean<IUser>().exec();
      if (!user) throw ApiError.unauthorized();
      socket.data.user = user;
      socket.data.typingAt = new Map();
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    void onConnection(io, ctx, socket).catch((err) => {
      ctx.logger.error({ err, socketId: socket.id }, 'socket connection handler failed');
      socket.disconnect(true);
    });
  });
}

async function onConnection(io: AppServer, ctx: AppContext, socket: AppSocket): Promise<void> {
  const user = socket.data.user;
  const userId = user._id.toHexString();
  const log = ctx.logger.child({ socketId: socket.id, userId, username: user.username });
  log.debug('socket connected');

  await socket.join(`user:${userId}`);
  const first = ctx.presence.add(userId, socket.id);
  if (first) {
    io.emit('presence:update', { userId, presence: ctx.presence.effective(userId, user.status) });
  }

  socket.emit('ready', {
    sessionId: socket.id,
    user: toUser(user, ctx.presence.effective(userId, user.status, userId), { self: true }),
    presences: await collectPresences(ctx, userId),
    voiceStates: ctx.voice.allStates(),
  });

  handle(socket, 'typing', typingSchema, async ({ channelId }) => {
    const now = Date.now();
    const last = socket.data.typingAt.get(channelId) ?? 0;
    if (now - last < TYPING_INTERVAL_MS) return;
    socket.data.typingAt.set(channelId, now);
    const channel = await loadVisibleChannel(channelId, user);
    if (channel.type === 'voice') throw ApiError.badRequest('음성 채널에는 입력 표시가 없습니다.');
    const payload = { channelId, userId };
    if (channel.type === 'dm') {
      socket.to(channel.participants.map((p) => `user:${p.toHexString()}`)).emit('typing', payload);
    } else {
      socket.broadcast.emit('typing', payload);
    }
  });

  handle(socket, 'voice:join', voiceJoinSchema, async ({ channelId }) => {
    const channel = await Channel.findById(channelId).lean<IChannel>().exec();
    if (!channel || channel.type !== 'voice') throw ApiError.notFound('음성 채널을 찾을 수 없습니다.');
    const changed = ctx.voice.join(channelId, socket.id, userId);
    for (const id of changed) io.emit('voice:state', ctx.voice.state(id));
    return ctx.voice.state(channelId);
  });

  handle(socket, 'voice:leave', emptySchema, async () => {
    const left = ctx.voice.leave(socket.id);
    if (left) io.emit('voice:state', ctx.voice.state(left));
  });

  handle(socket, 'voice:update', voiceUpdateSchema, async (patch) => {
    const channelId = ctx.voice.update(socket.id, patch);
    if (!channelId) throw ApiError.badRequest('음성 채널에 참여하고 있지 않습니다.');
    io.emit('voice:state', ctx.voice.state(channelId));
    return ctx.voice.state(channelId);
  });

  handle(socket, 'rtc:signal', signalSchema, async ({ to, scope, type, payload }) => {
    if (to === socket.id) throw ApiError.badRequest('자기 자신에게 보낼 수 없습니다.');
    if (!ctx.voice.sameChannel(socket.id, to))
      throw ApiError.forbidden('같은 음성 채널에 있는 상대에게만 보낼 수 있습니다.');
    if (JSON.stringify(payload ?? null).length > MAX_SIGNAL_BYTES)
      throw ApiError.payloadTooLarge('시그널이 너무 큽니다.');
    io.to(to).emit('rtc:signal', { from: socket.id, scope, type, payload });
  });

  handle(socket, 'screen:watch', targetSchema, async ({ to }) => {
    if (!ctx.voice.sameChannel(socket.id, to))
      throw ApiError.forbidden('같은 음성 채널에 있는 상대만 시청할 수 있습니다.');
    const target = ctx.voice.member(to);
    if (!target?.streaming) throw ApiError.badRequest('상대가 화면을 공유하고 있지 않습니다.');
    io.to(to).emit('screen:watch', { from: socket.id });
  });

  handle(socket, 'screen:unwatch', targetSchema, async ({ to }) => {
    if (!ctx.voice.sameChannel(socket.id, to)) return;
    io.to(to).emit('screen:unwatch', { from: socket.id });
  });

  socket.on('disconnect', (reason) => {
    log.debug({ reason }, 'socket disconnected');
    const left = ctx.voice.leave(socket.id);
    if (left) io.emit('voice:state', ctx.voice.state(left));
    const last = ctx.presence.remove(userId, socket.id);
    if (last) io.emit('presence:update', { userId, presence: 'offline' satisfies Presence });
  });
}

async function collectPresences(ctx: AppContext, viewerId: string): Promise<Record<string, Presence>> {
  const onlineIds = ctx.presence.onlineUserIds();
  if (onlineIds.length === 0) return {};
  const users = await User.find({ _id: { $in: onlineIds } })
    .select('status')
    .lean<Pick<IUser, '_id' | 'status'>[]>()
    .exec();
  const out: Record<string, Presence> = {};
  for (const u of users) {
    const id = u._id.toHexString();
    const presence = ctx.presence.effective(id, u.status, viewerId);
    if (presence !== 'offline') out[id] = presence;
  }
  return out;
}

async function loadVisibleChannel(channelId: string, user: IUser): Promise<IChannel> {
  const channel = await Channel.findById(channelId).lean<IChannel>().exec();
  if (!channel || !canSee(channel, user._id)) throw ApiError.notFound('채널을 찾을 수 없습니다.');
  return channel;
}

function handle<S extends ZodTypeAny>(
  socket: AppSocket,
  event: string,
  schema: S,
  fn: (payload: z.infer<S>) => Promise<unknown> | unknown,
): void {
  socket.on(event, async (raw: unknown, ack?: unknown) => {
    const cb: Ack | undefined = typeof ack === 'function' ? (ack as Ack) : undefined;
    try {
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) throw ApiError.validation('입력값이 올바르지 않습니다.');
      const data = await fn(parsed.data);
      cb?.(data === undefined ? { ok: true } : { ok: true, data });
    } catch (err) {
      const apiError = toApiError(err);
      cb?.({ ok: false, error: { code: apiError.code, message: apiError.message } });
    }
  });
}
