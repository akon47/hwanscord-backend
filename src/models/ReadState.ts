import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export interface IReadState {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  channelId: Types.ObjectId;
  lastReadMessageId: Types.ObjectId | null;
  updatedAt: Date;
  createdAt: Date;
}

export type ReadStateDoc = HydratedDocument<IReadState>;

const readStateSchema = new Schema<IReadState>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
    lastReadMessageId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: 'readstates' },
);

readStateSchema.index({ userId: 1, channelId: 1 }, { unique: true });

export const ReadState = mongoose.model<IReadState>('ReadState', readStateSchema);
