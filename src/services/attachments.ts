import path from 'node:path';
import type { Types } from 'mongoose';
import { Attachment, type IAttachment } from '../models/Attachment.js';
import { removeFileQuietly } from './files.js';
import type { Logger } from '../logger.js';

export function attachmentPath(uploadDir: string, storedName: string): string {
  return path.join(uploadDir, 'attachments', storedName);
}

/** Deletes attachment documents and their files. */
export async function deleteAttachments(uploadDir: string, filter: Record<string, unknown>): Promise<number> {
  const docs = await Attachment.find(filter)
    .select('storedName')
    .lean<Pick<IAttachment, '_id' | 'storedName'>[]>()
    .exec();
  if (docs.length === 0) return 0;
  await Promise.all(docs.map((d) => removeFileQuietly(attachmentPath(uploadDir, d.storedName))));
  await Attachment.deleteMany({ _id: { $in: docs.map((d) => d._id) } }).exec();
  return docs.length;
}

export async function deleteAttachmentsForMessages(
  uploadDir: string,
  messageIds: Types.ObjectId[],
): Promise<number> {
  if (messageIds.length === 0) return 0;
  return deleteAttachments(uploadDir, { messageId: { $in: messageIds } });
}

/** Removes uploads that were never attached to a message within `maxAgeMs`. */
export async function collectUnboundAttachments(
  uploadDir: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  return deleteAttachments(uploadDir, { messageId: null, createdAt: { $lt: cutoff } });
}

export function startAttachmentGc(uploadDir: string, intervalMs: number, logger: Logger): () => void {
  const timer = setInterval(() => {
    collectUnboundAttachments(uploadDir)
      .then((n) => {
        if (n > 0) logger.info({ removed: n }, 'attachment gc');
      })
      .catch((err) => logger.warn({ err }, 'attachment gc failed'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
