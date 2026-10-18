import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validateBody, validateQuery } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import { CSLINK_DIFFICULTIES, CSLINK_DIFFICULTY_KEYS, type CsLinkDifficulty,
  type CsLinkDifficultyFilters } from '../services/cslinkDifficulty';
import type { CsLinkPlay } from '../services/cslinkPlay';

const playerId = z.string().regex(/^(?:hltv:[1-9]\d{0,9}|legacy:[a-f0-9]{20}|cs-person-\d{6,})$/);
const pairSchema = { startId: playerId, endId: playerId, dataVersion: z.string().regex(/^[a-f0-9]{20}$/) };
const submitSchema = z.object({ ...pairSchema, routeIds: z.array(playerId).min(2).max(17) }).strict();
const revealSchema = z.object(pairSchema).strict();
const questionSchema = z.object({ difficulty: z.enum(CSLINK_DIFFICULTY_KEYS).default('normal') });
const MAX_JUMPS = 16;

/**
 * CS Link 练习：随机出题、按难度挑两端，不计分也不存成绩。
 * 接口无状态：题目两端由客户端回传，服务端只校验两端可出题、路线每一跳都有出处。
 */
export function createCsLinkPracticeRoutes(play: CsLinkPlay | null, enabled: boolean,
  filters: () => CsLinkDifficultyFilters | undefined, endpointAllowed: (id: string) => boolean) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_PLAY_DISABLED' });
    if (!play) return res.status(503).json({ code: 'CSLINK_PLAY_UNAVAILABLE' });
    next();
  });
  const pairOk = (startId: string, endId: string) => startId !== endId && endpointAllowed(startId) && endpointAllowed(endId);

  router.get('/question', rateLimit({ name: 'cslink-practice-question', limit: 60, windowSeconds: 60, key: requestIdentity }),
    validateQuery(questionSchema), (req, res) => {
      const difficulty = (req.query.difficulty as CsLinkDifficulty) || 'normal';
      const tier = CSLINK_DIFFICULTIES[difficulty];
      const graph = play!.pathGraph();
      const filter = filters()?.[difficulty];
      const pair = filter
        ? graph.sampleDistantPair(tier.minJumps, tier.maxJumps, 32, undefined, filter, `tier:${difficulty}`)
        : graph.sampleDistantPair(tier.minJumps, tier.maxJumps, 32, undefined, endpointAllowed);
      const start = pair && play!.getPathPlayer(pair.startId), end = pair && play!.getPathPlayer(pair.endId);
      if (!pair || !start || !end) return res.status(503).json({ code: 'NO_QUESTION' });
      res.json({ difficulty, dataVersion: graph.dataVersion, shortestJumps: pair.shortestJumps, start, end });
    });

  router.post('/submit', rateLimit({ name: 'cslink-practice-submit', limit: 90, windowSeconds: 60, key: requestIdentity }),
    validateBody(submitSchema), asyncHandler(async (req, res) => {
      const { startId, endId, dataVersion, routeIds } = req.body as z.infer<typeof submitSchema>;
      const graph = play!.pathGraph();
      if (dataVersion !== graph.dataVersion) return res.status(409).json({ code: 'VERSION_MISMATCH' });
      if (!pairOk(startId, endId)) return res.status(400).json({ code: 'BAD_QUESTION' });
      const now = Date.now();
      // 计时在客户端；这里只借 finish 校验路线
      const result = graph.finish({ roundId: 'practice', dataVersion, startId, endId,
        serverStartedAtMs: now, serverDeadlineAtMs: now + 1, maxJumps: MAX_JUMPS }, routeIds, now);
      if (!result.valid) return res.json({ code: 'INVALID_PATH', reason: result.reason });
      const { jumps, hops } = result.finish;
      res.json({ finish: { jumps, routeIds: result.finish.routeIds, hops } });
    }));

  router.post('/reveal', rateLimit({ name: 'cslink-practice-reveal', limit: 60, windowSeconds: 60, key: requestIdentity }),
    validateBody(revealSchema), (req, res) => {
      const { startId, endId, dataVersion } = req.body as z.infer<typeof revealSchema>;
      const graph = play!.pathGraph();
      if (dataVersion !== graph.dataVersion) return res.status(409).json({ code: 'VERSION_MISMATCH' });
      if (!pairOk(startId, endId)) return res.status(400).json({ code: 'BAD_QUESTION' });
      // 中间人优先用能搜到的选手，找不到再放开
      const found = graph.shortestRoute(startId, endId, endpointAllowed) || graph.shortestRoute(startId, endId);
      if (!found) return res.status(404).json({ code: 'NO_ROUTE' });
      const route = found.routeIds.map(id => play!.getPathPlayer(id));
      if (route.some(p => !p)) return res.status(404).json({ code: 'NO_ROUTE' });
      res.json({ answer: { routeIds: found.routeIds, jumps: found.routeIds.length - 1, hops: found.hops, route } });
    });
  return router;
}
