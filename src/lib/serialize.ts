import type { Types } from 'mongoose';
import type { IAttachment } from '../models/Attachment.js';
import type { IChannel } from '../models/Channel.js';
import type { IMessage, IReaction } from '../models/Message.js';
import type { IUser, UserStatus } from '../models/User.js';
import { idToString } from './ids.js';

export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export interface UserRefDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface UserDto extends UserRefDto {
  role: 'admin' | 'member';
  status: UserStatus;
  presence: Presence;
  customStatus: string | null;
  aboutMe: string | null;
  createdAt: string;
  settings?: Record<string, unknown>;
  hasPassword?: boolean;
  connections?: { provider: 'github'; login: string }[];
  email?: string | null;
  emailVerified?: boolean;
  emailRequired?: boolean;
}

export interface ChannelDto {
  id: string;
  type: IChannel['type'];
  name: string;
  topic: string | null;
  position: number;
  createdBy: string | null;
  participants: string[];
  lastMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface AttachmentDto {
  id: string;
  url: string;
  filename: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
}

export interface ReactionDto {
  emoji: string;
  count: number;
  userIds: string[];
}

export interface MessageDto {
  id: string;
  channelId: string;
  author: UserRefDto;
  content: string;
  attachments: AttachmentDto[];
  replyTo: { id: string; author: UserRefDto | null; content: string; deleted: boolean } | null;
  mentions: string[];
  mentionEveryone: boolean;
  reactions: ReactionDto[];
  pinned: boolean;
  editedAt: string | null;
  createdAt: string;
  nonce?: string;
}

export interface ReadStateDto {
  channelId: string;
  lastReadMessageId: string | null;
  unreadCount: number;
  mentionCount: number;
}

export type UserLike = Pick<IUser, 'username' | 'displayName' | 'avatarUrl'> & {
  _id: Types.ObjectId | string;
};

export function toUserRef(user: UserLike | null | undefined): UserRefDto | null {
  if (!user) return null;
  return {
    id: idToString(user._id) as string,
    username: user.username,
    displayName: user.displayName ?? user.username,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function toUser(user: IUser, presence: Presence, options: { self?: boolean } = {}): UserDto {
  const base: UserDto = {
    id: idToString(user._id) as string,
    username: user.username,
    displayName: user.displayName ?? user.username,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role ?? 'member',
    status: user.status ?? 'online',
    presence,
    customStatus: user.customStatus ?? null,
    aboutMe: user.aboutMe ?? null,
    createdAt: toIso(user.createdAt) ?? new Date(0).toISOString(),
  };
  if (options.self) {
    base.settings = user.settings ?? {};
    base.hasPassword = !!(user.passwordHash || user.password);
    base.connections = (user.oauthAccounts ?? []).map((a) => ({ provider: a.provider, login: a.login }));
    base.email = user.email ?? null;
    base.emailVerified = !!(user.email && user.emailVerifiedAt);
    base.emailRequired = !base.emailVerified;
  }
  return base;
}

export function toChannel(channel: IChannel): ChannelDto {
  return {
    id: idToString(channel._id) as string,
    type: channel.type,
    name: channel.type === 'dm' ? '' : channel.name,
    topic: channel.type === 'text' ? (channel.topic ?? null) : null,
    position: channel.position ?? 0,
    createdBy: idToString(channel.createdBy),
    participants:
      channel.type === 'dm' ? (channel.participants ?? []).map((p) => idToString(p) as string) : [],
    lastMessageId: idToString(channel.lastMessageId),
    lastMessageAt: toIso(channel.lastMessageAt),
    createdAt: toIso(channel.createdAt) ?? new Date(0).toISOString(),
  };
}

export function attachmentUrl(storedName: string): string {
  return `/uploads/attachments/${storedName}`;
}

export function toAttachment(a: IAttachment): AttachmentDto {
  return {
    id: idToString(a._id) as string,
    url: attachmentUrl(a.storedName),
    filename: a.filename,
    size: a.size,
    contentType: a.contentType,
    width: a.width ?? null,
    height: a.height ?? null,
  };
}

export function toReactions(reactions: IReaction[] | undefined): ReactionDto[] {
  return (reactions ?? [])
    .filter((r) => r.userIds.length > 0)
    .map((r) => ({
      emoji: r.emoji,
      count: r.userIds.length,
      userIds: r.userIds.map((u) => idToString(u) as string),
    }));
}

/** A message document after populating `authorId` and `attachmentIds` (replyTo stays an id). */
export interface PopulatedMessage extends Omit<IMessage, 'authorId' | 'attachmentIds'> {
  authorId: UserLike | Types.ObjectId | null;
  attachmentIds: (IAttachment | Types.ObjectId)[];
}

/** The referenced original of a reply: `_id`, `content` and populated author. */
export interface ReplySource {
  _id: Types.ObjectId;
  content: string;
  authorId: UserLike | Types.ObjectId | null;
}

function isUserLike(v: unknown): v is UserLike {
  return !!v && typeof v === 'object' && 'username' in (v as Record<string, unknown>);
}

function isAttachmentLike(v: unknown): v is IAttachment {
  return !!v && typeof v === 'object' && 'storedName' in (v as Record<string, unknown>);
}

const DELETED_AUTHOR: UserRefDto = {
  id: '000000000000000000000000',
  username: 'deleted',
  displayName: '삭제된 사용자',
  avatarUrl: null,
};

export function toMessage(
  m: PopulatedMessage,
  replies: Map<string, ReplySource>,
  nonce?: string,
): MessageDto {
  const author = isUserLike(m.authorId) ? toUserRef(m.authorId) : null;
  let replyTo: MessageDto['replyTo'] = null;
  if (m.replyTo) {
    const id = idToString(m.replyTo) as string;
    const source = replies.get(id);
    replyTo = source
      ? {
          id,
          author: isUserLike(source.authorId) ? toUserRef(source.authorId) : null,
          content: (source.content ?? '').slice(0, 200),
          deleted: false,
        }
      : { id, author: null, content: '', deleted: true };
  }
  const dto: MessageDto = {
    id: idToString(m._id) as string,
    channelId: idToString(m.channelId) as string,
    author: author ?? DELETED_AUTHOR,
    content: m.content ?? '',
    attachments: (m.attachmentIds ?? []).filter(isAttachmentLike).map(toAttachment),
    replyTo,
    mentions: (m.mentions ?? []).map((u) => idToString(u) as string),
    mentionEveryone: !!m.mentionEveryone,
    reactions: toReactions(m.reactions),
    pinned: !!m.pinned,
    editedAt: toIso(m.editedAt),
    createdAt: toIso(m.createdAt) ?? new Date(0).toISOString(),
  };
  if (nonce) dto.nonce = nonce;
  return dto;
}

export function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}
