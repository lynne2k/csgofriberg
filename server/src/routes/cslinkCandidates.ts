import { Router } from 'express';
import { z } from 'zod';
import { validateQuery } from '../middleware/common';
import { CsLinkCandidates } from '../services/cslinkCandidates';

const playerId = z.string().regex(/^hltv:[1-9]\d{0,9}$/);
const version = z.string().regex(/^[a-f0-9]{20}$/);

/** Isolated developer preview: no candidate store enters the reviewed-data API or game services. */
export function createCsLinkCandidateRoutes(store: CsLinkCandidates | null, enabled: boolean) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_CANDIDATES_DISABLED' });
    if (!store) return res.status(503).json({ code: 'CSLINK_CANDIDATES_UNAVAILABLE' });
    next();
  });
  router.get('/meta', (_req, res) => res.json(store!.metadata()));
  router.get('/players', validateQuery(z.object({ search: z.string().trim().max(100).default('') })),
    (req, res) => res.json(store!.search(String(req.query.search))));
  router.get('/relationship', validateQuery(z.object({
    playerA: playerId, playerB: playerId, version,
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })), (req, res) => res.json(store!.relationship(
    String(req.query.playerA), String(req.query.playerB), String(req.query.version), Number(req.query.offset)
  )));
  return router;
}
