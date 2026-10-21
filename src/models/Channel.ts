import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export const CHANNEL_TYPES = ['text', 'voice', 'dm'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export interface IChannel {
  _id: Types.ObjectId;
  type: ChannelType;
  name: string;
  topic: string | null;
  position: number;
  createdBy: Types.ObjectId | null;
  participants: Types.ObjectId[];
  lastMessageId: Types.ObjectId | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelDoc = HydratedDocument<IChannel>;

const channelSchema = new Schema<IChannel>(
  {
    type: { type: String, enum: CHANNEL_TYPES, required: true },
    name: { type: String, default: '', trim: true, maxlength: 100 },
    topic: { type: String, default: null, maxlength: 1024 },
    position: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    participants: { type: [Schema.Types.ObjectId], ref: 'User', default: [] },
    lastMessageId: { type: Schema.Types.ObjectId, default: null },
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'channels' },
);

// text/voice names are unique per type; dm channels have no name
channelSchema.index(
  { type: 1, name: 1 },
  { unique: true, partialFilterExpression: { type: { $in: ['text', 'voice'] } } },
);
channelSchema.index({ participants: 1 });

export const Channel = mongoose.model<IChannel>('Channel', channelSchema);
