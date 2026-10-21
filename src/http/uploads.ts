import express, { type RequestHandler } from 'express';
import mime from 'mime-types';
import { contentDisposition } from '../services/files.js';

/** Static serving of uploaded files with immutable caching and download-safe headers. */
export function uploadsStatic(uploadDir: string): RequestHandler {
  return express.static(uploadDir, {
    index: false,
    redirect: false,
    dotfiles: 'deny',
    etag: true,
    immutable: true,
    maxAge: '365d',
    setHeaders: (res, filePath) => {
      const type = mime.lookup(filePath) || 'application/octet-stream';
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Content-Disposition', contentDisposition(type));
      if (type === 'text/html' || type === 'application/xhtml+xml' || type === 'image/svg+xml') {
        // never let uploads execute as a page
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  });
}
