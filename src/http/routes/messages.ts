import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toReactions } from '../../lib/serialize.js';
import { Attachment, type IAttachment } from '../../models/Attachment.js';
import { Channel } from '../../models/Channel.js';
import { Message, type IMessage } from '../../models/Message.js';
import { deleteAttachmentsForMessages } from '../../services/attachments.js';
import { assertTextLike, getVisibleChannel, visibleChannelIds } from '../../services/channels.js';
import { parseMentions } from '../../services/mentions.js';
import { findMessageById, findMessages } from '../../services/messages.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { body, params, query, validate } from '../middleware/validate.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, '잘못된 식별자입니다.');
const channelParams = z.object({ id: objectId });
const messageParams = z.object({ id: objectId, mid: objectId });
const reactionParams = z.object({ id: objectId, mid: objectId, emoji: z.string().min(1) });

const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: objectId.optional(),
    after: objectId.optional(),
  })
  .refine((q) => !(q.before && q.after), {
    message: 'before 와 after 는 함께 쓸 수 없습니다.',
    path: ['before'],
  });

export const createMessageSchema = z
  .object({
    content: z.string().max(2000, '메시지는 2000자 이하여야 합니다.').default(''),
    attachmentIds: z.array(objectId).max(10, '첨부는 최대 10개입니다.').default([]),
    replyTo: objectId.optional(),
    nonce: z.string().max(64).optional(),
  })
  .refine((m) => m.content.trim().length > 0 || m.attachmentIds.length > 0, {
    message: '메시지 내용이나 첨부가 필요합니다.',
    path: ['content'],
  });

export const editMessageSchema = z.object({
  content: z.string().trim().min(1, '메시지 내용을 입력하세요.').max(2000),
});

const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  channelId: objectId.optional(),
  authorId: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

const EMOJI_CP_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|⃣)$/u;
const MAX_DISTINCT_REACTIONS = 20;

export function normalizeEmoji(raw: string): string {
  let emoji: string;
  try {
    emoji = decodeURIComponent(raw);
  } catch {
    throw ApiError.validation('이모지가 올바르지 않습니다.');
  }
  const codePoints = [...emoji];
  if (codePoints.length === 0 || codePoints.length > 8 || Buffer.byteLength(emoji, 'utf8') > 32) {
    throw ApiError.validation('이모지가 올바르지 않습니다.');
  }
  if (!codePoints.every((cp) => EMOJI_CP_RE.test(cp)))
    throw ApiError.validation('이모지가 올바르지 않습니다.');
  return emoji;
}

export function messagesRoutes(ctx: AppContext): Router {
  const router = Router({ mergeParams: true });
  router.use(requireAuth(ctx));
  const sendLimiter = makeRateLimiter(ctx.config, { windowMs: 1000, limit: 5, perUser: true });

  router.get('/', validate({ params: channelParams, query: listQuery }), async (req, res) => {
    const me = currentUser(req);
    const { id } = params(req, channelParams);
    const q = query(req, listQuery);
    const channel = await getVisibleChannel(id, me._id);
    assertTextLike(channel);
    const filter: Record<string, unknown> = { channelId: channel._id };
    if (q.before) filter._id = { $lt: new Types.ObjectId(q.before) };
    if (q.after) filter._id = { $gt: new Types.ObjectId(q.after) };
    const ascending = !!q.after;
    const page = await findMessages(filter, { sort: { _id: ascending ? 1 : -1 }, limit: q.limit + 1 });
    const hasMore = page.length > q.limit;
    const messages = page.slice(0, q.limit);
    if (!ascending) messages.reverse();
    res.json({ messages, hasMore });
  });

  router.post(
    '/',
    sendLimiter,
    validate({ params: channelParams, body: createMessageSchema }),
    async (req, res) => {
      const me = currentUser(req);
      const { id } = params(req, channelParams);
      const input = body(req, createMessageSchema);
      const channel = await getVisibleChannel(id, me._id);
      assertTextLike(channel);

      let attachments: IAttachment[] = [];
      if (input.attachmentIds.length > 0) {
        const ids = [...new Set(input.attachmentIds)].map((a) => new Types.ObjectId(a));
        attachments = await Attachment.find({ _id: { $in: ids }, uploaderId: me._id, messageId: null })
          .lean<IAttachment[]>()
          .exec();
        if (attachments.length !== ids.length)
          throw ApiError.badRequest('첨부 파일을 찾을 수 없거나 이미 사용되었습니다.');
      }
      if (input.replyTo) {
        const original = await Message.exists({ _id: input.replyTo, channelId: channel._id }).exec();
        if (!original) throw ApiError.badRequest('답장할 메시지를 찾을 수 없습니다.');
      }
      const content = input.content.replace(/\r\n/g, '\n').trimEnd();
      const { mentions, mentionEveryone } = await parseMentions(content);
      const created = await Message.create({
        channelId: channel._id,
        authorId: me._id,
        content,
        attachmentIds: attachments.map((a) => a._id),
        replyTo: input.replyTo ? new Types.ObjectId(input.replyTo) : null,
        mentions: mentions.map((m) => new Types.ObjectId(m)),
        mentionEveryone,
      });
      if (attachments.length > 0) {
        await Attachment.updateMany(
          { _id: { $in: attachments.map((a) => a._id) } },
          { $set: { messageId: created._id, channelId: channel._id } },
        ).exec();
      }
      await Channel.updateOne(
        { _id: channel._id },
        { $set: { lastMessageId: created._id, lastMessageAt: created.createdAt } },
      ).exec();
      const dto = await findMessageById(created._id, input.nonce);
      if (!dto) throw ApiError.internal();
      ctx.realtime.emitForChannel(channel, 'message:create', dto);
      res.status(201).json({ message: dto });
    },
  );

  router.patch('/:mid', validate({ params: messageParams, body: editMessageSchema }), async (req, res) => {
    const me = currentUser(req);
    const { id, mid } = params(req, messageParams);
    const input = body(req, editMessageSchema);
    const channel = await getVisibleChannel(id, me._id);
    const message = await Message.findOne({ _id: mid, channelId: channel._id }).lean<IMessage>().exec();
    if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
    if (!message.authorId.equals(me._id)) throw ApiError.forbidden('자신의 메시지만 수정할 수 있습니다.');
    const content = input.content.replace(/\r\n/g, '\n');
    const { mentions, mentionEveryone } = await parseMentions(content);
    await Message.updateOne(
      { _id: message._id },
      {
        $set: {
          content,
          mentions: mentions.map((m) => new Types.ObjectId(m)),
          mentionEveryone,
          editedAt: new Date(),
        },
      },
    ).exec();
    const dto = await findMessageById(message._id);
    if (!dto) throw ApiError.internal();
    ctx.realtime.emitForChannel(channel, 'message:update', dto);
    res.json({ message: dto });
  });

  router.delete('/:mid', validate({ params: messageParams }), async (req, res) => {
    const me = currentUser(req);
    const { id, mid } = params(req, messageParams);
    const channel = await getVisibleChannel(id, me._id);
    const message = await Message.findOne({ _id: mid, channelId: channel._id }).lean<IMessage>().exec();
    if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
    if (!message.authorId.equals(me._id) && me.role !== 'admin') {
      throw ApiError.forbidden('자신의 메시지나 관리자만 삭제할 수 있습니다.');
    }
    await deleteAttachmentsForMessages(ctx.config.uploadDir, [message._id]);
    await Message.deleteOne({ _id: message._id }).exec();
    if (channel.lastMessageId && channel.lastMessageId.equals(message._id)) {
      const last = await Message.findOne({ channelId: channel._id })
        .sort({ _id: -1 })
        .select('createdAt')
        .lean<IMessage>()
        .exec();
      await Channel.updateOne(
        { _id: channel._id },
        { $set: { lastMessageId: last?._id ?? null, lastMessageAt: last?.createdAt ?? null } },
      ).exec();
    }
    ctx.realtime.emitForChannel(channel, 'message:delete', { channelId: id, messageId: mid });
    res.status(204).end();
  });

  router.put('/:mid/reactions/:emoji', validate({ params: reactionParams }), async (req, res) => {
    const me = currentUser(req);
    const { id, mid, emoji: raw } = params(req, reactionParams);
    const emoji = normalizeEmoji(raw);
    const channel = await getVisibleChannel(id, me._id);
    const message = await Message.findOne({ _id: mid, channelId: channel._id }).lean<IMessage>().exec();
    if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
    const existing = message.reactions.find((r) => r.emoji === emoji);
    if (existing) {
      if (!existing.userIds.some((u) => u.equals(me._id))) {
        await Message.updateOne(
          { _id: message._id, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.userIds': me._id } },
        ).exec();
      }
    } else {
      if (message.reactions.length >= MAX_DISTINCT_REACTIONS)
        throw ApiError.badRequest('반응 종류는 메시지당 최대 20개입니다.');
      await Message.updateOne(
        { _id: message._id },
        { $push: { reactions: { emoji, userIds: [me._id] } } },
      ).exec();
    }
    await respondReactions(ctx, channel, message._id, res);
  });

  router.delete('/:mid/reactions/:emoji', validate({ params: reactionParams }), async (req, res) => {
    const me = currentUser(req);
    const { id, mid, emoji: raw } = params(req, reactionParams);
    const emoji = normalizeEmoji(raw);
    const channel = await getVisibleChannel(id, me._id);
    const message = await Message.findOne({ _id: mid, channelId: channel._id }).lean<IMessage>().exec();
    if (!message) throw ApiError.notFound('메시지를 찾을 수 없습니다.');
    await Message.updateOne(
      { _id: message._id, 'reactions.emoji': emoji },
      { $pull: { 'reactions.$.userIds': me._id } },
    ).exec();
    await Message.updateOne({ _id: message._id }, { $pull: { reactions: { userIds: { $size: 0 } } } }).exec();
    await respondReactions(ctx, channel, message._id, res);
  });

  return router;
}

async function respondReactions(
  ctx: AppContext,
  channel: Awaited<ReturnType<typeof getVisibleChannel>>,
  messageId: Types.ObjectId,
  res: { json: (b: unknown) => void },
): Promise<void> {
  const fresh = await Message.findById(messageId)
    .select('reactions')
    .lean<Pick<IMessage, 'reactions'>>()
    .exec();
  ctx.realtime.emitForChannel(channel, 'message:reactions', {
    channelId: channel._id.toHexString(),
    messageId: messageId.toHexString(),
    reactions: toReactions(fresh?.reactions),
  });
  const dto = await findMessageById(messageId);
  res.json({ message: dto });
}

export function searchRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/search', validate({ query: searchQuery }), async (req, res) => {
    const me = currentUser(req);
    const q = query(req, searchQuery);
    let channelIds = await visibleChannelIds(me._id);
    if (q.channelId) {
      channelIds = channelIds.filter((c) => c.toHexString() === q.channelId);
      if (channelIds.length === 0) throw ApiError.notFound('채널을 찾을 수 없습니다.');
    }
    const filter: Record<string, unknown> = { $text: { $search: q.q }, channelId: { $in: channelIds } };
    if (q.authorId) filter.authorId = new Types.ObjectId(q.authorId);
    const [results, total] = await Promise.all([
      findMessages(filter, { sort: { _id: -1 }, skip: q.offset, limit: q.limit }),
      Message.countDocuments(filter).exec(),
    ]);
    res.json({ results, total });
  });

  return router;
}
