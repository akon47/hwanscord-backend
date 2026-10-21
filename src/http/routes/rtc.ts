import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { requireAdmin, requireAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';

export function rtcRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));
  const limiter = makeRateLimiter(ctx.config, { windowMs: 10 * 60_000, limit: 10, perUser: true });

  router.get('/ice-servers', limiter, async (_req, res) => {
    res.json(await ctx.turn.getIceServers());
  });

  router.get('/usage', requireAdmin(), async (_req, res) => {
    res.json(await ctx.turn.getUsage());
  });

  return router;
}
