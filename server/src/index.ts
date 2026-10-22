import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config, validateProductionConfig } from './config';
import { assertDatabaseReady } from './db/ready';
import { db } from './db/knex';
import { errorHandler } from './middleware/common';
import authRoutes from './routes/auth';
import playerRoutes from './routes/players';
import gameRoutes from './routes/game';
import statsRoutes from './routes/stats';
import leaderboardRoutes from './routes/leaderboard';
import announcementRoutes from './routes/announcements';
import adminRoutes from './routes/admin';
import externalPlayerRoutes, { externalPlayerAuth } from './routes/externalPlayers';
import { setupSocket } from './socket';
import { setupCsLinkRooms } from './socket/cslinkRooms';
import { buildCsLinkDifficultyFilters, CSLINK_DIFFICULTIES, CSLINK_DIFFICULTY_KEYS } from './services/cslinkDifficulty';
import {
  closeRedis,
  duplicateRedisClient,
  initRedis,
  isRedisAvailable,
  isRedisTimeoutError,
} from './redis';
import { initPlayerCache } from './services/playerCache';
import { rateLimit } from './middleware/rateLimit';
import { initMatchResultWorker } from './services/matchResultQueue';
import powRoutes from './routes/pow';
import { requirePow } from './middleware/pow';
import { closePasswordWorkers } from './services/password';
import { getRuntimeSnapshot, startRuntimeMonitor } from './services/runtimeMonitor';
import { requireAdmin, requireAuth } from './middleware/auth';
import { parseJsonOnce, rejectOversizedBody } from './middleware/jsonBody';
import { rejectMissingClientAsset, setClientAssetCacheHeaders } from './middleware/clientAssets';
import { injectUmamiScript } from './services/umami';
import runtimeConfigRoutes from './routes/runtimeConfig';
import dailyChallengeRoutes from './routes/dailyChallenge';
import { CsLinkEvidence } from './services/cslinkEvidence';
import { createCsLinkRoutes } from './routes/cslink';
import { CsLinkCandidates } from './services/cslinkCandidates';
import { createCsLinkCandidateRoutes } from './routes/cslinkCandidates';
import { CsLinkMerged } from './services/cslinkMerged';
import { createCsLinkMergedRoutes } from './routes/cslinkMerged';
import { CsLinkPlay } from './services/cslinkPlay';
import { createCsLinkPlayRoutes } from './routes/cslinkPlay';
import { CsLinkLegacy } from './services/cslinkLegacy';
import { CsLinkDaily } from './services/cslinkDaily';
import { createCsLinkDailyRoutes } from './routes/cslinkDaily';
import { createCsLinkPracticeRoutes } from './routes/cslinkPractice';
import { CsLinkLadder } from './services/cslinkLadder';
import { createCsLinkLadderRoutes } from './routes/cslinkLadder';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const CLOUDFLARE_INSIGHTS_BEACON_ORIGIN = 'https://cloudflareinsights.com';
const GEETEST_SCRIPT_ORIGIN = 'https://static.geetest.com';
const GEETEST_API_ORIGIN = 'https://gcaptcha4.geetest.com';
const GEETEST_FALLBACK_API_ORIGIN = 'https://api.geetest.com';
const GEETEST_GEEVISIT_ORIGIN = 'https://gcaptcha4.geevisit.com';
const GEETEST_GSENSEBOT_ORIGIN = 'https://gcaptcha4.gsensebot.com';

process.on('unhandledRejection', (reason) => {
  if (isRedisTimeoutError(reason)) {
    console.error('[server:redis-timeout-unhandled]', reason);
    return;
  }
  console.error('[server:unhandled-rejection]', reason);
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
});

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout();
        reject(new Error('SHUTDOWN_TIMEOUT'));
      } catch (err) {
        reject(err);
      }
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function main() {
  validateProductionConfig();
  const stopRuntimeMonitor = startRuntimeMonitor();
  console.log('[server] 正在验证数据库结构');
  await assertDatabaseReady();
  console.log('[server] 数据库结构验证通过');
  const redisReady = await initRedis();
  await initPlayerCache();
  const stopMatchWorker = redisReady ? await initMatchResultWorker() : async () => undefined;
  // 本地开发默认打开；正式环境显式设置 CSLINK_ENABLED=true 才挂 CS Link 接口和房间
  const cslinkEnabled = process.env.NODE_ENV === 'development' || process.env.CSLINK_ENABLED === 'true';
  let cslink: CsLinkEvidence | null = null;
  if (cslinkEnabled && process.env.CSLINK_REVIEW_VERSION_DIR) {
    try {
      cslink = await CsLinkEvidence.open(process.env.CSLINK_REVIEW_VERSION_DIR);
      console.log(`[cslink] 本地复核数据已加载: ${cslink.version}`);
    } catch (error) {
      console.error('[cslink] 复核数据不可用，保留原游戏运行', error);
    }
  }
  let cslinkCandidates: CsLinkCandidates | null = null;
  if (cslinkEnabled && process.env.CSLINK_CANDIDATE_VERSION_DIR) {
    try {
      cslinkCandidates = await CsLinkCandidates.open(process.env.CSLINK_CANDIDATE_VERSION_DIR);
      console.log(`[cslink] 只读候选库已加载: ${cslinkCandidates.version}`);
    } catch (error) {
      console.error('[cslink] 候选库校验失败，候选 API 不可用', error);
    }
  }
  let cslinkLegacy: CsLinkLegacy | null = null;
  if (cslinkEnabled && process.env.CSLINK_LEGACY_RELATIONS_DIR) {
    try {
      cslinkLegacy = CsLinkLegacy.open(process.env.CSLINK_LEGACY_RELATIONS_DIR);
      if (cslinkLegacy) console.log(`[cslink] GitHub 旧库关系已加载: ${cslinkLegacy.version}`);
    } catch (error) {
      console.error('[cslink] GitHub 旧库关系导入失败，保留已加载来源', error);
    }
  }
  let activeLegacy: CsLinkLegacy | null = null;
  let cslinkPlay: CsLinkPlay | null = null;
  if (cslinkEnabled && cslinkCandidates && process.env.CSLINK_CANDIDATE_VERSION_DIR &&
      process.env.CSLINK_PLAY_PROJECTION_DIR) {
    let historicalInput: { projectionDir: string; candidateDir: string;
      candidates: CsLinkCandidates } | null = null;
    if (process.env.CSLINK_HISTORICAL_CANDIDATE_DIR &&
        process.env.CSLINK_HISTORICAL_PLAY_PROJECTION_DIR) {
      try {
        historicalInput = {
          candidateDir: process.env.CSLINK_HISTORICAL_CANDIDATE_DIR,
          projectionDir: process.env.CSLINK_HISTORICAL_PLAY_PROJECTION_DIR,
          candidates: await CsLinkCandidates.open(process.env.CSLINK_HISTORICAL_CANDIDATE_DIR),
        };
      } catch (error) {
        console.error('[cslink] 历史候选库不可用，保留当前可玩图', error);
      }
    }
    try {
      cslinkPlay = await CsLinkPlay.open(process.env.CSLINK_PLAY_PROJECTION_DIR,
        process.env.CSLINK_CANDIDATE_VERSION_DIR, cslinkCandidates, cslink, historicalInput, cslinkLegacy);
      activeLegacy = cslinkLegacy;
      console.log(`[cslink] 本地可玩关系图已加载: ${cslinkPlay.dataVersion}`);
    } catch (error) {
      console.error('[cslink] 本地可玩关系图校验失败', error);
      if (historicalInput || cslinkLegacy) {
        try {
          cslinkPlay = await CsLinkPlay.open(process.env.CSLINK_PLAY_PROJECTION_DIR,
            process.env.CSLINK_CANDIDATE_VERSION_DIR, cslinkCandidates, cslink);
          console.log(`[cslink] 当前赛事关系图已回退加载: ${cslinkPlay.dataVersion}`);
        } catch (fallbackError) {
          console.error('[cslink] 当前赛事关系图校验失败，原数据接口保持运行', fallbackError);
        }
      }
    }
  }
  // 题目两端：有定妆照，且 2024 起还在 S/A 出场。中间人仍可用全部身份；源库不删人。
  const portraitIds = new Set<string>();
  const portraitDir = process.env.CSLINK_PORTRAIT_DIR;
  if (portraitDir && fs.existsSync(portraitDir)) {
    for (const file of fs.readdirSync(portraitDir)) {
      const match = /^([1-9]\d{0,9})\.(?:png|jpe?g|webp)$/i.exec(file);
      if (match) portraitIds.add(`hltv:${match[1]}`);
    }
    console.log(`[cslink] 定妆照 ${portraitIds.size} 张，对战题目只从这些选手里出`);
  }
  const activeIds = new Set<string>();
  const activeFile = process.env.CSLINK_ACTIVE_IDS_FILE ||
    path.resolve(__dirname, '../../client/public/cslink/data/active-ids.json');
  if (fs.existsSync(activeFile)) {
    const parsed = JSON.parse(fs.readFileSync(activeFile, 'utf8')) as { fromYear?: number; ids?: unknown };
    if (Array.isArray(parsed.ids)) for (const id of parsed.ids) if (typeof id === 'string') activeIds.add(id);
    console.log(`[cslink] 活跃名单 ${activeIds.size} 人（${parsed.fromYear ?? '?'} 年起有 S/A 出场），题目两端只从这些人里出`);
  } else {
    console.warn(`[cslink] 没找到活跃名单 ${activeFile}，题目两端不按出场年份过滤`);
  }
  const cslinkEndpointOk = (id: string) =>
    (portraitIds.size === 0 || portraitIds.has(id)) && (activeIds.size === 0 || activeIds.has(id));
  // 难度排名用的热度分：2024 起 S 级赛事届数为主，再看 A/S 届数和生涯图数；少数大牌手动置顶
  const popularity = new Map<string, number>();
  const popularityFile = path.resolve(__dirname, '../../client/public/cslink/data/popularity.json');
  if (fs.existsSync(popularityFile)) {
    const parsed = JSON.parse(fs.readFileSync(popularityFile, 'utf8')) as { scores?: Record<string, unknown>; legends?: unknown };
    for (const [id, score] of Object.entries(parsed.scores ?? {})) if (typeof score === 'number') popularity.set(id, score);
    // 老将名单：2024 起不再打 S/A、但新老赛事加权后仍排进前列的人，放回题目两端
    const legends = Array.isArray(parsed.legends) ? parsed.legends.filter((id): id is string => typeof id === 'string') : [];
    if (activeIds.size) for (const id of legends) activeIds.add(id);
    console.log(`[cslink] 热度分 ${popularity.size} 人（新老赛事加权），放回老将 ${legends.length} 人`);
  } else {
    console.warn(`[cslink] 没找到热度分 ${popularityFile}，难度分档退回按生涯图数排名`);
  }
  let cslinkMerged: CsLinkMerged | null = null;
  if (cslink || cslinkCandidates) {
    try {
      cslinkMerged = new CsLinkMerged(cslink, cslinkCandidates,
        cslinkPlay?.candidateScope() ?? null, cslinkPlay?.historicalScope() ?? null, activeLegacy);
      console.log(`[cslink] 本地统一关系视图已加载: ${cslinkMerged.version}`);
    } catch (error) {
      console.error('[cslink] 统一关系视图不可用，原数据接口保持运行', error);
    }
  }

  const app = express();
  app.set('trust proxy', config.trustProxy ? 1 : false);

  // index.html 含内联脚本(主题开关、启动屏进度),CSP 不放开 unsafe-inline,
  // 而是从实际服务的 HTML 计算各内联脚本的 sha256 哈希加入 script-src
  const clientDist = path.resolve(__dirname, '../../client/dist');
  const clientIndexPath = path.join(clientDist, 'index.html');
  const rawIndexHtml = fs.existsSync(clientIndexPath)
    ? fs.readFileSync(clientIndexPath, 'utf8')
    : null;
  // 除了根 index.html，/cslink/*.html 等独立页面也有内联脚本和 onclick，同样要算哈希
  const sha = (s: string) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
  const clientHtmlFiles: string[] = [];
  const walkHtml = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory() && ent.name !== 'assets') walkHtml(full); // 软链接目录（定妆照）不跟进
      else if (ent.isFile() && ent.name.endsWith('.html')) clientHtmlFiles.push(full);
    }
  };
  walkHtml(clientDist);
  const inlineScriptHashes = new Set<string>();
  const inlineHandlerHashes = new Set<string>();
  for (const file of clientHtmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) inlineScriptHashes.add(sha(m[1]));
    for (const m of html.matchAll(/\son[a-z]+="([^"]*)"/g)) inlineHandlerHashes.add(sha(m[1]));
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'wasm-unsafe-eval'",
          CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN,
          GEETEST_SCRIPT_ORIGIN,
          GEETEST_API_ORIGIN,
          GEETEST_GEEVISIT_ORIGIN,
          GEETEST_GSENSEBOT_ORIGIN,
          ...(config.umami ? [config.umami.origin] : []),
          ...inlineScriptHashes,
        ],
        // 内联事件处理（返回按钮、关于弹窗、HLTV 小图标）按哈希放行
        scriptSrcAttr: inlineHandlerHashes.size ? ["'unsafe-hashes'", ...inlineHandlerHashes] : ["'none'"],
        workerSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", GEETEST_SCRIPT_ORIGIN],
        imgSrc: [
          "'self'",
          'data:',
          GEETEST_SCRIPT_ORIGIN,
          GEETEST_API_ORIGIN,
          GEETEST_GEEVISIT_ORIGIN,
          GEETEST_GSENSEBOT_ORIGIN,
        ],
        fontSrc: ["'self'", 'data:', GEETEST_SCRIPT_ORIGIN],
        connectSrc: [
          "'self'",
          ...config.corsOrigins,
          CLOUDFLARE_INSIGHTS_BEACON_ORIGIN,
          GEETEST_API_ORIGIN,
          GEETEST_FALLBACK_API_ORIGIN,
          GEETEST_GEEVISIT_ORIGIN,
          GEETEST_GSENSEBOT_ORIGIN,
          ...(config.umami ? [config.umami.origin] : []),
        ],
        objectSrc: ["'none'"],
        frameSrc: [
          "'self'",
          'https://*.geetest.com',
          GEETEST_GEEVISIT_ORIGIN,
          GEETEST_GSENSEBOT_ORIGIN,
        ],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }));
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use((req, res, next) => {
    if (shuttingDown) return res.status(503).json({ code: 'SERVER_SHUTTING_DOWN' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && !config.corsOrigins.includes(origin)) {
        return res.status(403).json({ code: 'INVALID_ORIGIN' });
      }
    }
    next();
  });
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      redis: isRedisAvailable() ? 'up' : 'degraded',
      features: { leaderboard: config.showLeaderboard },
      runtime: getRuntimeSnapshot(),
    })
  );
  app.use('/api', rateLimit({ name: 'api', limit: 600, windowSeconds: 60 }));
  app.use('/api/pow', rejectOversizedBody(16 * 1024), parseJsonOnce('16kb'));
  app.use('/api/pow', powRoutes);
  // Public runtime configuration is deliberately mounted before the PoW gate.
  // It contains only non-secret browser configuration such as the GeeTest ID.
  app.use('/api/runtime-config', runtimeConfigRoutes);
  app.use('/api/external', externalPlayerAuth);
  app.use(
    '/api/external',
    rejectOversizedBody(config.adminImportBodyLimitBytes),
    parseJsonOnce(`${config.adminImportBodyLimitBytes}b`)
  );
  app.use('/api/external', externalPlayerRoutes);
  app.use('/api', requirePow);
  app.use('/api/admin/players/import', requireAuth, requireAdmin);
  app.use(
    '/api/admin/players/import',
    rejectOversizedBody(config.adminImportBodyLimitBytes),
    parseJsonOnce(`${config.adminImportBodyLimitBytes}b`)
  );
  app.use('/api', rejectOversizedBody(64 * 1024), parseJsonOnce('64kb'));

  app.use('/api/auth', authRoutes);
  app.use('/api/players', playerRoutes);
  app.use('/api/cslink/candidates', createCsLinkCandidateRoutes(cslinkCandidates, cslinkEnabled));
  app.use('/api/cslink/merged', createCsLinkMergedRoutes(cslinkMerged, cslinkEnabled));
  app.use('/api/cslink/play', createCsLinkPlayRoutes(cslinkPlay, cslinkCandidates, cslink, cslinkEnabled));
  // 每日挑战两端和房间用同一个过滤（cslinkEndpointOk 在下面 socket 初始化前填好，请求时才读）
  const cslinkDaily = cslinkEnabled && cslinkPlay
    ? new CsLinkDaily(cslinkPlay, (id: string) => cslinkEndpointOk(id), Date.now,
      // 每日题用普通档；分档在下面 socket 初始化前建好，请求时才读
      () => difficultyFilters?.normal) : null;
  app.use('/api/cslink/daily', createCsLinkDailyRoutes(cslinkDaily, cslinkEnabled));
  // 练习：随机题、可选难度、不计分；分档同样请求时才读
  app.use('/api/cslink/drill', createCsLinkPracticeRoutes(cslinkEnabled ? cslinkPlay : null, cslinkEnabled,
    () => difficultyFilters, (id: string) => cslinkEndpointOk(id)));
  // 天梯分：访客和登录用户都按身份 key 记，落盘到 JSON
  const cslinkLadder = cslinkEnabled ? new CsLinkLadder(process.env.CSLINK_LADDER_FILE ||
    path.resolve(__dirname, '../../.local-data/cslink-ladder.json')) : null;
  app.use('/api/cslink/ladder', createCsLinkLadderRoutes(cslinkLadder, cslinkEnabled));
  app.use('/api/cslink', createCsLinkRoutes(cslink, cslinkEnabled));
  app.use('/api/game', gameRoutes);
  app.use('/api/daily-challenge', dailyChallengeRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/leaderboard', leaderboardRoutes);
  app.use('/api/announcements', announcementRoutes);
  app.use('/api/admin', adminRoutes);

  // 生产环境托管前端构建产物
  if (rawIndexHtml !== null) {
    const indexHtml = injectUmamiScript(rawIndexHtml, config.umami);
    app.use(express.static(clientDist, { index: false, setHeaders: setClientAssetCacheHeaders }));
    app.use(rejectMissingClientAsset);
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml);
    });
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.corsOrigins, credentials: true },
    // Keep WebSocket extensions disabled until compression can be gated before
    // the Engine.IO handshake. Namespace middleware runs too late for this.
    perMessageDeflate: false,
  });
  app.set('io', io);
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let adapterPubClient: ReturnType<typeof duplicateRedisClient> = null;
  let adapterSubClient: ReturnType<typeof duplicateRedisClient> = null;
  io.use((_socket, next) => {
    if (shuttingDown) return next(new Error('SERVER_SHUTTING_DOWN'));
    next();
  });
  if (redisReady) {
    adapterPubClient = duplicateRedisClient('socket-adapter-pub');
    adapterSubClient = duplicateRedisClient('socket-adapter-sub');
    if (adapterPubClient && adapterSubClient) {
      await Promise.all([adapterPubClient.connect(), adapterSubClient.connect()]);
      io.adapter(createAdapter(adapterPubClient, adapterSubClient));
    }
  }
  const stopSocket = setupSocket(io);
  // 难度分档：在能当两端的选手里按出场图数排名，热门选手进简单档
  let difficultyFilters: ReturnType<typeof buildCsLinkDifficultyFilters>['filters'] | undefined;
  if (cslinkEnabled && cslinkPlay) {
    const play = cslinkPlay;
    const mapCount = (id: string) => {
      if (popularity.size) return popularity.get(id) ?? 0;
      const p = play.getPathPlayer(id);
      return p ? p.verifiedMapCount + p.candidateMapCount + (p.legacyMapCount ?? 0) : 0;
    };
    const built = buildCsLinkDifficultyFilters(play.pathGraph().ids(), cslinkEndpointOk, mapCount);
    difficultyFilters = built.filters;
    console.log(`[cslink] 难度分档：可出题 ${built.ranked.length} 人；` + CSLINK_DIFFICULTY_KEYS.map(key => {
      const tier = CSLINK_DIFFICULTIES[key];
      return `${tier.label} 前${Number.isFinite(tier.topN) ? tier.topN : '全部'}人·${tier.minJumps}-${tier.maxJumps}跳`;
    }).join('，'));
  }
  const stopCsLinkRooms = cslinkEnabled && cslinkPlay ? setupCsLinkRooms(io, cslinkPlay, {
    countdownMs: 3_000,
    // 等所有人打开对战页的宽限上限；全员到齐后提前开表
    arrivalGraceMs: 12_000,
    interRoundMs: 6_000,
    endpointAllowed: portraitIds.size || activeIds.size ? cslinkEndpointOk : undefined,
    difficultyFilters,
    ladder: cslinkLadder ?? undefined,
  }) : () => undefined;

  server.listen(config.port, () => {
    console.log(`[server] 弗一把服务已启动: http://localhost:${config.port}`);
    console.log(`[server] allowed origins: ${config.corsOrigins.join(', ')}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      console.log(`[server] 收到 ${signal},开始优雅退出`);
      stopCsLinkRooms();
      try { cslinkLadder?.flush(); } catch (error) { console.error('[cslink] 天梯分保存失败', error); }
      stopRuntimeMonitor();
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
      const socketClosed = new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([
        withTimeout(serverClosed, SHUTDOWN_TIMEOUT_MS, () => server.closeAllConnections?.()),
        withTimeout(socketClosed, SHUTDOWN_TIMEOUT_MS, () => io.disconnectSockets(true)),
        withTimeout(stopMatchWorker(), SHUTDOWN_TIMEOUT_MS, () => undefined),
      ]);
      await withTimeout(stopSocket(), SHUTDOWN_TIMEOUT_MS, () => undefined).catch((err) => {
        console.error('[shutdown:socket-drain]', err);
      });

      await Promise.allSettled([
        withTimeout(
          adapterPubClient?.isOpen ? adapterPubClient.quit().then(() => undefined) : Promise.resolve(),
          SHUTDOWN_TIMEOUT_MS,
          () => undefined
        ),
        withTimeout(
          adapterSubClient?.isOpen ? adapterSubClient.quit().then(() => undefined) : Promise.resolve(),
          SHUTDOWN_TIMEOUT_MS,
          () => undefined
        ),
        withTimeout(closeRedis(), SHUTDOWN_TIMEOUT_MS, () => undefined),
        withTimeout(closePasswordWorkers(), SHUTDOWN_TIMEOUT_MS, () => undefined),
        withTimeout(db.destroy(), SHUTDOWN_TIMEOUT_MS, () => undefined),
      ]);
      console.log('[server] 优雅退出完成');
      cslink?.close();
      cslinkCandidates?.close();
    })();
    return shutdownPromise;
  };
  const handleSignal = (signal: string) => {
    const forceExitTimer = setTimeout(() => {
      console.error('[server] 优雅退出超时,强制退出');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS * 2 + 2_000);
    void shutdown(signal)
      .then(() => {
        clearTimeout(forceExitTimer);
        process.exit(0);
      })
      .catch((err) => {
        clearTimeout(forceExitTimer);
        console.error('[server] 优雅退出失败:', err);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
