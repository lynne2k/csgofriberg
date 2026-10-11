import { Router } from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../middleware/common';
import { CsLinkCandidates } from '../services/cslinkCandidates';
import { CsLinkEvidence } from '../services/cslinkEvidence';
import { CsLinkPlay } from '../services/cslinkPlay';

const id = z.string().regex(/^(?:hltv:[1-9]\d{0,9}|legacy:[a-f0-9]{20})$/);
const version = z.string().regex(/^[a-f0-9]{20}$/);
const round = z.object({ questionId: version, bankVersion: version });

/** Local game graph shared by practice and CS Link path rooms; the reviewed API stays separate. */
export function createCsLinkPlayRoutes(store: CsLinkPlay | null, candidates: CsLinkCandidates | null,
  reviewed: CsLinkEvidence | null, enabled: boolean) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_PLAY_DISABLED' });
    if (!store || !candidates) return res.status(503).json({ code: 'CSLINK_PLAY_UNAVAILABLE' });
    next();
  });
  router.get('/meta', (_req, res) => res.json(store!.metadata()));
  router.get('/players', validateQuery(z.object({ search: z.string().trim().max(100).default('') })),
    (req, res) => res.json(store!.search(String(req.query.search), candidates!, reviewed)));
  router.get('/question', validateQuery(z.object({
    pool: z.enum(['bridge', 'multiple', 'all']).default('bridge'), previous: version.optional(),
  })), (req, res) => res.json(store!.question(
    req.query.pool as 'bridge' | 'multiple' | 'all', req.query.previous as string | undefined)));
  router.get('/question/:questionId', validateQuery(z.object({ bankVersion: version })),
    (req, res) => res.json(store!.questionById(String(req.params.questionId), String(req.query.bankVersion))));
  router.post('/answer', validateBody(round.extend({ playerId: id })),
    (req, res) => res.json(store!.answer(req.body.questionId, req.body.bankVersion, req.body.playerId)));
  router.post('/reveal', validateBody(round),
    (req, res) => res.json(store!.reveal(req.body.questionId, req.body.bankVersion)));
  router.get('/path', validateQuery(z.object({ playerA: id, playerB: id, version })),
    (req, res) => res.json(store!.shortestPath(String(req.query.playerA), String(req.query.playerB), String(req.query.version))));
  return router;
}
