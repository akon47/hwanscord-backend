import path from 'node:path';
import multer from 'multer';
import { Types } from 'mongoose';
import { ApiError } from '../../lib/errors.js';
import { safeExtension } from '../../services/files.js';

export const AVATAR_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!AVATAR_TYPES.has(file.mimetype)) {
      cb(ApiError.unsupportedMediaType('아바타는 PNG, JPEG, GIF, WebP 이미지만 가능합니다.'));
      return;
    }
    cb(null, true);
  },
});

/** Streams attachments straight into UPLOAD_DIR/attachments as `<objectId>.<ext>`. */
export function attachmentUpload(uploadDir: string) {
  return multer({
    storage: multer.diskStorage({
      destination: path.join(uploadDir, 'attachments'),
      filename: (_req, file, cb) => {
        const id = new Types.ObjectId().toHexString();
        const ext = safeExtension(file.originalname, file.mimetype);
        cb(null, ext ? `${id}.${ext}` : id);
      },
    }),
    limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 },
  });
}
