import mongoose, { Schema, type Types } from 'mongoose';

export interface IMeta {
  _id: Types.ObjectId;
  key: string;
  value: unknown;
}

const metaSchema = new Schema<IMeta>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed },
  },
  { collection: 'meta' },
);

export const Meta = mongoose.model<IMeta>('Meta', metaSchema);
