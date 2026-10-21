import type { Types } from 'mongoose';
import { ApiError } from '../lib/errors.js';
import { Channel, type IChannel } from '../models/Channel.js';

/** Channels the user may see: every text/voice channel plus their own DMs. */
export function visibleChannelFilter(userId: Types.ObjectId | string) {
  return { $or: [{ type: { $in: ['text', 'voice'] } }, { type: 'dm', participants: userId }] };
}

export async function listVisibleChannels(userId: Types.ObjectId): Promise<IChannel[]> {
  return Channel.find(visibleChannelFilter(userId))
    .sort({ type: 1, position: 1, createdAt: 1 })
    .lean<IChannel[]>()
    .exec();
}

export async function visibleChannelIds(userId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const docs = await Channel.find(visibleChannelFilter(userId))
    .select('_id')
    .lean<{ _id: Types.ObjectId }[]>()
    .exec();
  return docs.map((d) => d._id);
}

export function canSee(channel: IChannel, userId: Types.ObjectId | string): boolean {
  if (channel.type !== 'dm') return true;
  const id = userId.toString();
  return channel.participants.some((p) => p.toString() === id);
}

/** Loads a channel the user may see, 404 otherwise (DMs of other people are invisible). */
export async function getVisibleChannel(channelId: string, userId: Types.ObjectId): Promise<IChannel> {
  const channel = await Channel.findById(channelId).lean<IChannel>().exec();
  if (!channel || !canSee(channel, userId)) throw ApiError.notFound('채널을 찾을 수 없습니다.');
  return channel;
}

export function assertTextLike(channel: IChannel): void {
  if (channel.type === 'voice') throw ApiError.badRequest('음성 채널에는 메시지를 보낼 수 없습니다.');
}

export function canManageChannel(channel: IChannel, user: { _id: Types.ObjectId; role: string }): boolean {
  if (user.role === 'admin') return true;
  return !!channel.createdBy && channel.createdBy.toString() === user._id.toString();
}

export async function nextPosition(type: IChannel['type']): Promise<number> {
  const last = await Channel.findOne({ type })
    .sort({ position: -1 })
    .select('position')
    .lean<{ position: number }>()
    .exec();
  return last ? (last.position ?? 0) + 1 : 0;
}
