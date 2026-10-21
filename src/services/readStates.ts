import type { Types } from 'mongoose';
import { Message } from '../models/Message.js';
import { ReadState, type IReadState } from '../models/ReadState.js';
import type { IChannel } from '../models/Channel.js';
import type { ReadStateDto } from '../lib/serialize.js';
import { idToString } from '../lib/ids.js';

export async function computeReadState(
  userId: Types.ObjectId,
  channel: IChannel,
  state?: IReadState | null,
): Promise<ReadStateDto> {
  const rs =
    state === undefined
      ? await ReadState.findOne({ userId, channelId: channel._id }).lean<IReadState>().exec()
      : state;
  const lastRead = rs?.lastReadMessageId ?? null;
  if (channel.type === 'voice') {
    return {
      channelId: channel._id.toHexString(),
      lastReadMessageId: idToString(lastRead),
      unreadCount: 0,
      mentionCount: 0,
    };
  }
  const base: Record<string, unknown> = { channelId: channel._id, authorId: { $ne: userId } };
  if (lastRead) base._id = { $gt: lastRead };
  const unreadCount = await Message.countDocuments(base).exec();
  let mentionCount = 0;
  if (unreadCount > 0) {
    mentionCount =
      channel.type === 'dm'
        ? unreadCount
        : await Message.countDocuments({
            ...base,
            $or: [{ mentions: userId }, { mentionEveryone: true }],
          }).exec();
  }
  return {
    channelId: channel._id.toHexString(),
    lastReadMessageId: idToString(lastRead),
    unreadCount,
    mentionCount,
  };
}

export async function computeReadStates(
  userId: Types.ObjectId,
  channels: IChannel[],
): Promise<ReadStateDto[]> {
  const states = await ReadState.find({ userId, channelId: { $in: channels.map((c) => c._id) } })
    .lean<IReadState[]>()
    .exec();
  const byChannel = new Map(states.map((s) => [s.channelId.toString(), s]));
  const out: ReadStateDto[] = [];
  for (const channel of channels) {
    out.push(await computeReadState(userId, channel, byChannel.get(channel._id.toString()) ?? null));
  }
  return out;
}
