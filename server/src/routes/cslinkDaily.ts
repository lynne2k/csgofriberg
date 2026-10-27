import { Router, type Request } from 'express';
import { z } from 'zod';
import { optionalAuth, userNameFromUsername } from '../middleware/auth';
import { asyncHandler, validateBody, validateQuery } from '../middleware/common';
import { rateLimit, requestIdentity } from '../middleware/rateLimit';
import type { CsLinkDaily } from '../services/cslinkDaily';
import { cleanCsLinkNickname } from '../services/cslinkNickname';

const playerId = z.string().regex(/^(?:hltv:[1-9]\d{0,9}|legacy:[a-f0-9]{20}|cs-person-\d{6,})$/);
const nickname = z.string().max(64).optional();
const nicknameSchema = z.object({ nickname }).strict();
const submitSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dataVersion: z.string().regex(/^[a-f0-9]{20}$/),
  routeIds: z.array(playerId).min(2).max(17),
  nickname,
});

/** 身份 key 决定成绩归属；昵称只换显示名，不合规就退回访客编号 */
function owner(req: Request) {
  const nick = cleanCsLinkNickname(req.body?.nickname);
  if (req.user) return { key: `u:${req.user.id}`, name: nick ?? userNameFromUsername(req.user.username) };
  if (req.guestKey) return { key: `g:${req.guestKey}`, name: nick ?? (req.guestName || '访客') };
  return null;
}

/** CS Link 每日挑战：同一天同一道题，服务端计时、服务端判定路线 */
export function createCsLinkDailyRoutes(daily: CsLinkDaily | null, enabled: boolean) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) return res.status(404).json({ code: 'CSLINK_PLAY_DISABLED' });
    if (!daily) return res.status(503).json({ code: 'CSLINK_PLAY_UNAVAILABLE' });
    next();
  });
  router.use(optionalAuth);
  router.get('/today', (_req, res) => {
    const today = daily!.today();
    if (!today) return res.status(503).json({ code: 'NO_QUESTION' });
    res.json(today);
  });
  /** 起昵称时先问一下能不能用；词库只在服务端，不下发给前端 */
  router.post('/nickname-check', rateLimit({ name: 'cslink-nick-check', limit: 20, windowSeconds: 60, key: requestIdentity }),
    validateBody(nicknameSchema), (req, res) => {
      res.json({ ok: cleanCsLinkNickname(req.body?.nickname) !== null });
    });
  router.post('/start', rateLimit({ name: 'cslink-daily-start', limit: 30, windowSeconds: 60, key: requestIdentity }),
    validateBody(nicknameSchema), asyncHandler(async (req, res) => {
      const me = owner(req);
      if (!me) return res.status(400).json({ code: 'GUEST_KEY_REQUIRED' });
      const out = await daily!.start(me.key, me.name);
      if ('code' in out) return res.status(503).json(out);
      res.json(out);
    }));
  router.post('/begin', rateLimit({ name: 'cslink-daily-begin', limit: 30, windowSeconds: 60, key: requestIdentity }),
    validateBody(nicknameSchema), asyncHandler(async (req, res) => {
      const me = owner(req);
      if (!me) return res.status(400).json({ code: 'GUEST_KEY_REQUIRED' });
      const out = await daily!.begin(me.key, me.name);
      if ('code' in out) return res.status(409).json(out);
      res.json(out);
    }));
  router.post('/submit', rateLimit({ name: 'cslink-daily-submit', limit: 60, windowSeconds: 60, key: requestIdentity }),
    validateBody(submitSchema), asyncHandler(async (req, res) => {
      const me = owner(req);
      if (!me) return res.status(400).json({ code: 'GUEST_KEY_REQUIRED' });
      const out = await daily!.submit(me.key, me.name, req.body);
      if ('code' in out && out.code !== 'INVALID_PATH') return res.status(409).json(out);
      res.json(out);
    }));
  router.get('/leaderboard', validateQuery(z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) })),
    asyncHandler(async (req, res) => {
      const me = owner(req);
      const out = await daily!.leaderboard(me?.key ?? null, Number(req.query.limit) || 10);
      if ('code' in out) return res.status(503).json(out);
      res.json(out);
    }));
  return router;
}
