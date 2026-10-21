import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export interface IReaction {
  emoji: string;
  userIds: Types.ObjectId[];
}

export interface IMessage {
  _id: Types.ObjectId;
  channelId: Types.ObjectId;
  authorId: Types.ObjectId;
  content: string;
  attachmentIds: Types.ObjectId[];
  replyTo: Types.ObjectId | null;
  mentions: Types.ObjectId[];
  mentionEveryone: boolean;
  reactions: IReaction[];
  pinned: boolean;
  pinnedAt: Date | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageDoc = HydratedDocument<IMessage>;

const reactionSchema = new Schema<IReaction>(
  {
    emoji: { type: String, required: true },
    userIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const messageSchema = new Schema<IMessage>(
  {
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, default: '', maxlength: 2000 },
    attachmentIds: { type: [Schema.Types.ObjectId], ref: 'Attachment', default: [] },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    mentions: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    mentionEveryone: { type: Boolean, default: false },
    reactions: { type: [reactionSchema], default: [] },
    pinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'messages' },
);

messageSchema.index({ channelId: 1, _id: -1 });
messageSchema.index({ channelId: 1, pinned: 1, pinnedAt: -1 });
messageSchema.index({ content: 'text' }, { default_language: 'none', name: 'content_text' });

export const Message = mongoose.model<IMessage>('Message', messageSchema);
