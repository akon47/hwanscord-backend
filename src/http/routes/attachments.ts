import path from 'node:path';
import fs from 'node:fs/promises';
import { Router } from 'express';
import sharp from 'sharp';
import type { AppContext } from '../../context.js';
import { ApiError } from '../../lib/errors.js';
import { toAttachment } from '../../lib/serialize.js';
import { Attachment, type IAttachment } from '../../models/Attachment.js';
import { decodeOriginalName, sanitizeFilename } from '../../services/files.js';
import { currentUser, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { attachmentUpload } from '../middleware/upload.js';

export function attachmentsRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));
  const limiter = makeRateLimiter(ctx.config, { windowMs: 60_000, limit: 30, perUser: true });
  const upload = attachmentUpload(ctx.config.uploadDir);

  router.post('/', limiter, upload.single('file'), async (req, res) => {
    const me = currentUser(req);
    const file = req.file;
    if (!file) throw ApiError.badRequest('file 필드가 필요합니다.');
    const storedName = path.basename(file.path);
    const id = storedName.split('.')[0] as string;
    let width: number | null = null;
    let height: number | null = null;
    let contentType = file.mimetype || 'application/octet-stream';
    if (contentType.startsWith('image/')) {
      try {
        const meta = await sharp(file.path).metadata();
        width = meta.width ?? null;
        height = meta.height ?? null;
        if (meta.format) {
          const detected = `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}`;
          if (detected !== contentType) contentType = detected;
        }
      } catch {
        // not a decodable image; keep the declared type but drop dimensions
        width = null;
        height = null;
      }
    }
    try {
      const created = await Attachment.create({
        _id: id,
        storedName,
        filename: sanitizeFilename(decodeOriginalName(file.originalname)),
        size: file.size,
        contentType,
        width,
        height,
        uploaderId: me._id,
        messageId: null,
        channelId: null,
      });
      res.status(201).json({ attachment: toAttachment(created.toObject() as IAttachment) });
    } catch (err) {
      await fs.unlink(file.path).catch(() => undefined);
      throw err;
    }
  });

  return router;
}
