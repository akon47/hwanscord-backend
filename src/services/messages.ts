import type { FilterQuery, Types } from 'mongoose';
import { Message, type IMessage } from '../models/Message.js';
import { toMessage, type MessageDto, type PopulatedMessage, type ReplySource } from '../lib/serialize.js';

export const AUTHOR_FIELDS = 'username displayName avatarUrl';

interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export async function findMessages(
  filter: FilterQuery<IMessage>,
  options: FindOptions = {},
): Promise<MessageDto[]> {
  let q = Message.find(filter);
  if (options.sort) q = q.sort(options.sort);
  if (options.skip) q = q.skip(options.skip);
  if (options.limit) q = q.limit(options.limit);
  const docs = (await q
    .populate({ path: 'authorId', select: AUTHOR_FIELDS })
    .populate({ path: 'attachmentIds' })
    .lean()
    .exec()) as unknown as PopulatedMessage[];
  return hydrateReplies(docs);
}

export async function findMessageById(
  id: Types.ObjectId | string,
  nonce?: string,
): Promise<MessageDto | null> {
  const doc = (await Message.findById(id)
    .populate({ path: 'authorId', select: AUTHOR_FIELDS })
    .populate({ path: 'attachmentIds' })
    .lean()
    .exec()) as unknown as PopulatedMessage | null;
  if (!doc) return null;
  const [dto] = await hydrateReplies([doc], nonce);
  return dto ?? null;
}

/** Resolves `replyTo` references in one extra query so deleted originals are still reported. */
async function hydrateReplies(docs: PopulatedMessage[], nonce?: string): Promise<MessageDto[]> {
  const replyIds = docs.map((d) => d.replyTo).filter((r): r is Types.ObjectId => !!r);
  const replies = new Map<string, ReplySource>();
  if (replyIds.length > 0) {
    const found = (await Message.find({ _id: { $in: replyIds } })
      .select('content authorId')
      .populate({ path: 'authorId', select: AUTHOR_FIELDS })
      .lean()
      .exec()) as unknown as ReplySource[];
    for (const r of found) replies.set(r._id.toString(), r);
  }
  return docs.map((d) => toMessage(d, replies, nonce));
}
