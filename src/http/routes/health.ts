import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { dbState } from '../../db.js';

export function healthRoutes(ctx: AppContext): Router {
  const router = Router();
  router.get('/healthz', (_req, res) => {
    const mongo = dbState();
    res.status(mongo === 'connected' ? 200 : 503).json({
      status: mongo === 'connected' ? 'ok' : 'degraded',
      version: ctx.config.appVersion,
      uptime: Math.round(process.uptime() * 10) / 10,
      mongo,
    });
  });
  return router;
}
