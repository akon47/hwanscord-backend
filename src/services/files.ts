import fs from 'node:fs/promises';
import path from 'node:path';
import mime from 'mime-types';

export const INLINE_TYPES = /^(image\/|video\/|audio\/|text\/plain$|application\/pdf$)/;

export async function ensureUploadDirs(uploadDir: string): Promise<void> {
  await fs.mkdir(path.join(uploadDir, 'avatars'), { recursive: true });
  await fs.mkdir(path.join(uploadDir, 'attachments'), { recursive: true });
}

/** Removes path components and control characters; keeps unicode letters so Korean names survive. */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  const limited = cleaned.length > 200 ? cleaned.slice(-200) : cleaned;
  return limited || 'file';
}

/** Lower-case extension (without dot) suitable for a stored file name, or '' when unknown. */
export function safeExtension(originalName: string, contentType: string): string {
  const fromName = path.extname(originalName).slice(1).toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const fromType = mime.extension(contentType);
  return fromType && /^[a-z0-9]{1,8}$/.test(fromType) ? fromType : '';
}

/**
 * busboy/multer decode the multipart `filename` parameter as latin1 while browsers send UTF-8.
 * Re-decode when the result round-trips cleanly (Korean file names otherwise become mojibake).
 */
export function decodeOriginalName(name: string): string {
   
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? name : decoded;
}

export async function removeFileQuietly(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function contentDisposition(contentType: string): 'inline' | 'attachment' {
  return INLINE_TYPES.test(contentType) ? 'inline' : 'attachment';
}
