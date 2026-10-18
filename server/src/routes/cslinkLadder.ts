import { Router, type Request } from 'express';
import { z } from 'zod';
import { optionalAuth } from '../middleware/auth';
import { validateQuery } from '../middleware/common';
import type { CsLinkLadder } from '../services/cslinkLadder';

function ownerKey(req: Request) {
  if (req.user) return `u:${req.user.id}`;
  if (req.guestKey) return `g:${req.guestKey}`;
  return null;
}

/** 天梯排行榜：全站前 N 名 + 自己的分数和名次。分数只在天梯局结束时变。 */
export function createCsLinkLadderRoutes(ladder: CsLinkLadder | null, enabled: boolean) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_PLAY_DISABLED' });
    if (!ladder) return res.status(503).json({ code: 'CSLINK_PLAY_UNAVAILABLE' });
    next();
  });
  router.use(optionalAuth);
  router.get('/top', validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(50).default(10) })), (req, res) => {
    const key = ownerKey(req);
    res.json({ top: ladder!.top(Number(req.query.limit) || 10), me: key ? ladder!.standing(key) : null });
  });
  return router;
}
