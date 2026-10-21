import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export interface IAttachment {
  _id: Types.ObjectId;
  /** file name inside UPLOAD_DIR/attachments */
  storedName: string;
  filename: string;
  size: number;
  contentType: string;
  width: number | null;
  height: number | null;
  uploaderId: Types.ObjectId;
  messageId: Types.ObjectId | null;
  channelId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AttachmentDoc = HydratedDocument<IAttachment>;

const attachmentSchema = new Schema<IAttachment>(
  {
    storedName: { type: String, required: true },
    filename: { type: String, required: true, maxlength: 255 },
    size: { type: Number, required: true },
    contentType: { type: String, required: true },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    uploaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    channelId: { type: Schema.Types.ObjectId, ref: 'Channel', default: null },
  },
  { timestamps: true, collection: 'attachments' },
);

attachmentSchema.index({ messageId: 1 });
attachmentSchema.index({ channelId: 1 });
attachmentSchema.index({ messageId: 1, createdAt: 1 });

export const Attachment = mongoose.model<IAttachment>('Attachment', attachmentSchema);
