import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { compareIds } from '../../lib/ids.js';
import { toChannel } from '../../lib/serialize.js';
import { Channel, type IChannel } from '../../models/Channel.js';
import { Message, type IMessage } from '../../models/Message.js';
import { ReadState, type IReadState } from '../../models/ReadState.js';
import { User } from '../../models/User.js';
import { deleteAttachments } from '../../services/attachments.js';
import {
  assertTextLike,
  canManageChannel,
  getVisibleChannel,
  listVisibleChannels,
  nextPosition,
} from '../../services/channels.js';
import { findMessageById, findMessages } from '../../services/messages.js';
import { computeReadState, computeReadStates } from '../../services/readStates.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { body, params, validate } from '../middleware/validate.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, '잘못된 식별자입니다.');
const idParams = z.object({ id: objectId });
const idAndMessageParams = z.object({ id: objectId, messageId: objectId });

const channelName = z
  .string()
  .trim()
  .min(1, '채널 이름을 입력하세요.')
  .max(100, '채널 이름은 100자 이하여야 합니다.')
  .refine((v) => !/[\r\n]/.test(v), '채널 이름에 줄바꿈을 넣을 수 없습니다.');

export const createChannelSchema = z.object({
  type: z.enum(['text', 'voice']),
  name: channelName,
  topic: z.string().trim().max(1024).nullable().optional(),
});

export const patchChannelSchema = z
  .object({
    name: channelName.optional(),
    topic: z
      .string()
      .trim()
      .max(1024)
      .nullable()
      .transform((v) => (v === '' ? null : v))
      .optional(),
    position: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

const dmSchema = z.object({ userId: objectId });
const ackSchema = z.object({ messageId: objectId });

export function channelsRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const channels = await listVisibleChannels(me._id);
    res.json({ channels: channels.map(toChannel) });
  });

  router.post('/', validate({ body: createChannelSchema }), async (req, res) => {
    const me = currentUser(req);
    const input = body(req, createChannelSchema);
    const dup = await Channel.exists({ type: input.type, name: input.name }).exec();
    if (dup) throw ApiError.conflict('같은 이름의 채널이 이미 있습니다.');
    const created = await Channel.create({
      type: input.type,
      name: input.name,
      topic: input.type === 'text' ? (input.topic ?? null) : null,
      position: await nextPosition(input.type),
      createdBy: me._id,
      participants: [],
    });
    const dto = toChannel(created.toObject() as IChannel);
    ctx.realtime.emitAll('channel:create', dto);
    res.status(201).json({ channel: dto });
  });

  router.post('/dm', validate({ body: dmSchema }), async (req, res) => {
    const me = currentUser(req);
    const { userId } = body(req, dmSchema);
    if (userId === me._id.toHexString()) throw ApiError.badRequest('자기 자신과는 DM 을 만들 수 없습니다.');
    const other = await User.exists({ _id: userId }).exec();
    if (!other) throw ApiError.notFound('사용자를 찾을 수 없습니다.');
    const pair = [me._id.toHexString(), userId].sort(compareIds).map((id) => new Types.ObjectId(id));
    const existing = await Channel.findOne({ type: 'dm', participants: { $all: pair, $size: 2 } })
      .lean<IChannel>()
      .exec();
    if (existing) {
      res.status(200).json({ channel: toChannel(existing) });
      return;
    }
    const created = await Channel.create({
      type: 'dm',
      name: '',
      participants: pair,
      createdBy: me._id,
      position: 0,
    });
    const dto = toChannel(created.toObject() as IChannel);
    ctx.realtime.emitToUsers(dto.participants, 'channel:create', dto);
    res.status(201).json({ channel: dto });
  });

  router.patch('/:id', validate({ params: idParams, body: patchChannelSchema }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    const input = body(req, patchChannelSchema);
    const channel = await getVisibleChannel(id, me._id);
    if (channel.type === 'dm') throw ApiError.badRequest('DM 채널은 수정할 수 없습니다.');
    if (!canManageChannel(channel, me))
      throw ApiError.forbidden('채널을 만든 사람이나 관리자만 수정할 수 있습니다.');
    const $set: Record<string, unknown> = {};
    if (input.name !== undefined) $set.name = input.name;
    if (input.topic !== undefined && channel.type === 'text') $set.topic = input.topic;
    if (input.position !== undefined) $set.position = input.position;
    if (Object.keys($set).length === 0) throw ApiError.validation('변경할 항목이 없습니다.');
    if (input.name !== undefined && input.name !== channel.name) {
      const dup = await Channel.exists({
        type: channel.type,
        name: input.name,
        _id: { $ne: channel._id },
      }).exec();
      if (dup) throw ApiError.conflict('같은 이름의 채널이 이미 있습니다.');
    }
    const updated = await Channel.findByIdAndUpdate(channel._id, { $set }, { new: true })
      .lean<IChannel>()
      .exec();
    if (!updated) throw ApiError.notFound();
    const dto = toChannel(updated);
    ctx.realtime.emitAll('channel:update', dto);
    res.json({ channel: dto });
  });

  router.delete('/:id', validate({ params: idParams }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    const channel = await getVisibleChannel(id, me._id);
    if (channel.type === 'dm') throw ApiError.badRequest('DM 채널은 삭제할 수 없습니다.');
    if (!canManageChannel(channel, me))
      throw ApiError.forbidden('채널을 만든 사람이나 관리자만 삭제할 수 있습니다.');
    await deleteAttachments(ctx.config.uploadDir, { channelId: channel._id });
    await Message.deleteMany({ channelId: channel._id }).exec();
    await ReadState.deleteMany({ channelId: channel._id }).exec();
    await Channel.deleteOne({ _id: channel._id }).exec();
    const kicked = ctx.voice.clearChannel(channel._id.toHexString());
    if (kicked.length > 0)
      ctx.realtime.emitAll('voice:state', { channelId: channel._id.toHexString(), members: [] });
    ctx.realtime.emitAll('channel:delete', { channelId: channel._id.toHexString() });
    res.status(204).end();
  });

  router.get('/:id/pins', validate({ params: idParams }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    const channel = await getVisibleChannel(id, me._id);
    assertTextLike(channel);
    const messages = await findMessages(
      { channelId: channel._id, pinned: true },
      { sort: { pinnedAt: -1, _id: -1 }, limit: 100 },
    );
    res.json({ messages });
  });

  router.put('/:id/pins/:messageId', validate({ params: idAndMessageParams }), async (req, res) => {
    await setPinned(ctx, req, res, true);
  });

  router.delete('/:id/pins/:messageId', validate({ params: idAndMessageParams }), async (req, res) => {
    await setPinned(ctx, req, res, false);
  });

  router.post('/:id/ack', validate({ params: idParams, body: ackSchema }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, idParams);
    const { messageId } = body(req, ackSchema);
    const channel = await getVisibleChannel(id, me._id);
    const message = await Message.exists({ _id: messageId, channelId: channel._id }).exec();
    if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
    const current = await ReadState.findOne({ userId: me._id, channelId: channel._id })
      .lean<IReadState>()
      .exec();
    if (!current?.lastReadMessageId || compareIds(messageId, current.lastReadMessageId.toHexString()) > 0) {
      await ReadState.updateOne(
        { userId: me._id, channelId: channel._id },
        { $set: { lastReadMessageId: new Types.ObjectId(messageId) } },
        { upsert: true },
      ).exec();
    }
    const readState = await computeReadState(me._id, channel);
    ctx.realtime.emitToUsers([me._id.toHexString()], 'readstate:update', readState);
    res.json({ readState });
  });

  return router;
}

export function readStatesRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));
  router.get('/', async (req, res) => {
    const me = currentUser(req);
    const channels = await listVisibleChannels(me._id);
    res.json({ readStates: await computeReadStates(me._id, channels) });
  });
  return router;
}

async function setPinned(
  ctx: AppContext,
  req: Parameters<Parameters<Router['put']>[1]>[0],
  res: Parameters<Parameters<Router['put']>[1]>[1],
  pinned: boolean,
): Promise<void> {
  const me = currentUser(req);
  const { id, messageId } = params(req, idAndMessageParams);
  const channel = await getVisibleChannel(id, me._id);
  assertTextLike(channel);
  const message = await Message.findOne({ _id: messageId, channelId: channel._id }).lean<IMessage>().exec();
  if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
  if (message.pinned !== pinned) {
    await Message.updateOne(
      { _id: message._id },
      { $set: { pinned, pinnedAt: pinned ? new Date() : null } },
    ).exec();
    ctx.realtime.emitForChannel(channel, 'message:pin', { channelId: id, messageId, pinned });
  }
  const dto = await findMessageById(message._id);
  res.json({ message: dto });
}
