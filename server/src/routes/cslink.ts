import { Router } from 'express';
import { z } from 'zod';
import { validateBody, validateQuery } from '../middleware/common';
import { CsLinkEvidence } from '../services/cslinkEvidence';
import { CsLinkQuestions } from '../services/cslinkQuestions';

const id = z.string().regex(/^cs-person-\d{6,}$/).max(40);

export function createCsLinkRoutes(store: CsLinkEvidence | null, enabled: boolean) {
  const router = Router();
  let bank: CsLinkQuestions | undefined;
  const questions = () => bank ??= new CsLinkQuestions(store!);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_DISABLED' });
    if (!store) return res.status(503).json({ code: 'CSLINK_UNAVAILABLE' });
    next();
  });
  router.get('/meta', (_req, res) => res.json(store!.metadata()));
  const version = z.string().regex(/^[a-f0-9]{20}$/);
  const round = z.object({ questionId: version, bankVersion: version });
  router.get('/practice/meta', (_req, res) => res.json(questions().metadata()));
  router.get('/practice/question', validateQuery(z.object({
    pool: z.enum(['bridge', 'multiple', 'all']).default('bridge'), previous: version.optional(),
  })), (req, res) => res.json(questions().question(req.query.pool as 'bridge' | 'multiple' | 'all', req.query.previous as string | undefined)));
  router.get('/practice/question/:questionId', validateQuery(z.object({ bankVersion: version })),
    (req, res) => res.json(questions().questionById(String(req.params.questionId), String(req.query.bankVersion))));
  router.post('/practice/answer', validateBody(round.extend({ playerId: id })),
    (req, res) => res.json(questions().answer(req.body.questionId, req.body.bankVersion, req.body.playerId)));
  router.post('/practice/reveal', validateBody(round),
    (req, res) => res.json(questions().reveal(req.body.questionId, req.body.bankVersion)));
  router.get('/players', validateQuery(z.object({ search: z.string().trim().max(100).default('') })),
    (req, res) => res.json(store!.search(String(req.query.search))));
  router.get('/relationship', validateQuery(z.object({
    playerA: id, playerB: id, version: z.string().regex(/^[a-f0-9]{20}$/),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })), (req, res) => res.json(store!.relationship(
    String(req.query.playerA), String(req.query.playerB), String(req.query.version), Number(req.query.offset)
  )));
  return router;
}
