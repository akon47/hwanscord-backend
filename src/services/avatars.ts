import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Types } from 'mongoose';
import { ApiError } from '../lib/errors.js';
import { removeFileQuietly } from './files.js';

/** Resizes to a 256×256 WebP (animated GIFs stay animated), writes it and returns its public URL. */
export async function storeAvatar(
  uploadDir: string,
  userId: Types.ObjectId,
  input: Buffer,
  previousUrl: string | null,
): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await sharp(input, { animated: true })
      .rotate()
      .resize(256, 256, { fit: 'cover', position: 'centre' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw ApiError.unsupportedMediaType('이미지를 처리할 수 없습니다.');
  }
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  const fileName = `${userId.toHexString()}-${hash}.webp`;
  await fs.writeFile(path.join(uploadDir, 'avatars', fileName), buffer);
  const avatarUrl = `/uploads/avatars/${fileName}`;
  if (previousUrl && previousUrl !== avatarUrl) await removeAvatarFile(uploadDir, previousUrl);
  return avatarUrl;
}

export async function removeAvatarFile(uploadDir: string, avatarUrl: string): Promise<void> {
  const name = path.basename(avatarUrl);
  if (!/^[\w.-]+$/.test(name)) return;
  try {
    await removeFileQuietly(path.join(uploadDir, 'avatars', name));
  } catch {
    // best effort: a stale avatar file is harmless
  }
}
