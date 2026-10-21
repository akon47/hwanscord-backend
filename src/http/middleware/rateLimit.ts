import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../../config.js';
import { ApiError } from '../../lib/errors.js';

interface Options {
  windowMs: number;
  limit: number;
  /** key by authenticated user when available (falls back to IP) */
  perUser?: boolean;
}

const passThrough: RequestHandler = (_req, _res, next) => next();

/** Collapses an IPv6 address to its /64 so one client cannot rotate through a whole prefix. */
function ipKey(ip: string | undefined): string {
  if (!ip) return 'ip:unknown';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `ip:${parts.slice(0, 4).join(':')}`;
  }
  return `ip:${ip}`;
}

export function makeRateLimiter(config: Config, options: Options): RequestHandler {
  if (!config.rateLimit.enabled) return passThrough;
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const userId = options.perUser ? req.user?._id?.toString() : undefined;
      return userId ? `u:${userId}` : ipKey(req.ip);
    },
    handler: (_req, res, _next, info) => {
      res.setHeader('Retry-After', String(Math.ceil(info.windowMs / 1000)));
      res.status(429).json(ApiError.rateLimited().toBody());
    },
  });
}
