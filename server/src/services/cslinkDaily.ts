import crypto from 'crypto';
import { redis, redisKey } from '../redis';
import { dailyChallengeWindow } from './dailyChallenge';
import { compareCsLinkPathFinishes, type CsLinkPathFinish } from './cslinkPaths';
import type { CsLinkRoomStore } from './cslinkRooms';
import type { PlayPlayer } from './cslinkPlay';

/** 第 1 期的上海日期；题号 = 距今天数 + 1 */
const FIRST_DAY = '2026-10-11';
/** 从这一天起每日题固定用普通档（前 150 名热门选手、正好 3 跳）；普通档成绩单独存，不和当天旧题混在一起 */
export const CSLINK_DAILY_NORMAL_FROM = '2026-10-16';
const MAX_JUMPS = 16;
const RETENTION_SECONDS = 3 * 24 * 60 * 60;
const MAX_ENTRIES_PER_DAY = 50_000;

export interface CsLinkDailyRun {
  key: string;
  name: string;
  /** 第一次放牌时才记下；只打开页面不算开始 */
  startedAtMs: number | null;
  attempts: number;
  best: { jumps: number; elapsedMs: number; routeIds: string[]; completedAtMs: number } | null;
}
export interface CsLinkDailyToday {
  date: string; no: number; dataVersion: string; shortestJumps: number;
  start: PlayPlayer; end: PlayPlayer; nextRefreshAt: number;
  /** 成绩存储分区：日期，普通档再加后缀 */
  bucket: string;
}

/** 按日期 + 数据版本生成可复现的随机数，同一天所有人拿到同一道题 */
function seededRandom(seed: string) {
  let counter = 0;
  return (maxExclusive: number) => {
    const digest = crypto.createHash('sha256').update(`${seed}:${counter++}`).digest();
    return digest.readUInt32BE(0) % maxExclusive;
  };
}

function dayNumber(date: string) {
  const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return Math.max(1, Math.round((ms(date) - ms(FIRST_DAY)) / 86_400_000) + 1);
}

/** 记录存储：优先 Redis（hash: 身份 -> JSON），没有 Redis 时退回进程内存 */
interface RunStore {
  get(date: string, key: string): Promise<CsLinkDailyRun | null>;
  set(date: string, run: CsLinkDailyRun): Promise<void>;
  all(date: string): Promise<CsLinkDailyRun[]>;
  size(date: string): Promise<number>;
}
const memory = new Map<string, Map<string, CsLinkDailyRun>>();
const runStore: RunStore = {
  async get(date, key) {
    const client = redis();
    if (!client) return memory.get(date)?.get(key) ?? null;
    const raw = await client.hGet(redisKey(`cslink:daily:${date}`), key);
    return raw ? JSON.parse(raw) as CsLinkDailyRun : null;
  },
  async set(date, run) {
    const client = redis();
    if (!client) {
      if (!memory.has(date)) { memory.clear(); memory.set(date, new Map()); }
      memory.get(date)!.set(run.key, run); return;
    }
    const k = redisKey(`cslink:daily:${date}`);
    await client.hSet(k, run.key, JSON.stringify(run));
    await client.expire(k, RETENTION_SECONDS);
  },
  async all(date) {
    const client = redis();
    if (!client) return [...(memory.get(date)?.values() ?? [])];
    const raw = await client.hGetAll(redisKey(`cslink:daily:${date}`));
    return Object.values(raw).map(value => JSON.parse(value) as CsLinkDailyRun);
  },
  async size(date) {
    const client = redis();
    if (!client) return memory.get(date)?.size ?? 0;
    return client.hLen(redisKey(`cslink:daily:${date}`));
  },
};

export class CsLinkDaily {
  private cache: { date: string; dataVersion: string; today: CsLinkDailyToday } | null = null;
  constructor(private readonly store: CsLinkRoomStore,
    private readonly endpointAllowed?: (id: string) => boolean,
    private readonly now: () => number = Date.now,
    /** 普通档两端过滤；在难度分档建好后才可用，所以传 getter */
    private readonly normalFilter?: () => ((id: string) => boolean) | undefined) {}

  today(): CsLinkDailyToday | null {
    const window = dailyChallengeWindow(this.now());
    const graph = this.store.pathGraph();
    if (this.cache && this.cache.date === window.date && this.cache.dataVersion === graph.dataVersion) {
      return this.cache.today;
    }
    const seed = `cslink-daily:${window.date}:${graph.dataVersion}`;
    const normal = window.date >= CSLINK_DAILY_NORMAL_FROM ? this.normalFilter?.() : undefined;
    const normalPair = normal ? graph.sampleDistantPair(3, 3, 32, seededRandom(seed), normal, 'tier:normal') : null;
    const pair = normalPair || graph.sampleDistantPair(3, 5, 32, seededRandom(seed), this.endpointAllowed);
    if (!pair) return null;
    const start = this.store.getPathPlayer(pair.startId), end = this.store.getPathPlayer(pair.endId);
    if (!start || !end) return null;
    const today = { date: window.date, no: dayNumber(window.date), dataVersion: graph.dataVersion,
      shortestJumps: pair.shortestJumps, start, end, nextRefreshAt: window.nextRefreshAt,
      // 普通档按两端选手分区：分档规则变了题目换了，旧成绩不会混进新题
      bucket: normalPair ? `${window.date}:normal:${pair.startId}:${pair.endId}` : window.date };
    this.cache = { date: window.date, dataVersion: graph.dataVersion, today };
    return today;
  }

  /** 打开题目：只登记参与，不开始计时；改了昵称就顺手更新显示名 */
  async start(key: string, name: string) {
    const today = this.today();
    if (!today) return { code: 'NO_QUESTION' as const };
    let run = await runStore.get(today.bucket, key);
    if (!run) {
      if (await runStore.size(today.bucket) >= MAX_ENTRIES_PER_DAY) return { code: 'DAILY_FULL' as const };
      run = { key, name, startedAtMs: null, attempts: 0, best: null };
      await runStore.set(today.bucket, run);
    } else if (run.name !== name) {
      run.name = name;
      await runStore.set(today.bucket, run);
    }
    return { today, run: this.publicRun(run), serverNowMs: this.now() };
  }

  /** 第一次放牌时开始计时，记服务端时间；重复调用不会重置 */
  async begin(key: string, name: string) {
    const today = this.today();
    if (!today) return { code: 'NO_QUESTION' as const };
    const run = await runStore.get(today.bucket, key);
    if (!run) return { code: 'NOT_STARTED' as const };
    if (run.startedAtMs == null) { run.startedAtMs = this.now(); run.name = name; await runStore.set(today.bucket, run); }
    return { run: this.publicRun(run), serverNowMs: this.now() };
  }

  async submit(key: string, name: string, input: { date: string; dataVersion: string; routeIds: string[] }) {
    const today = this.today();
    if (!today) return { code: 'NO_QUESTION' as const };
    if (input.date !== today.date) return { code: 'DAILY_EXPIRED' as const };
    if (input.dataVersion !== today.dataVersion) return { code: 'VERSION_MISMATCH' as const };
    const run = await runStore.get(today.bucket, key);
    if (!run || run.startedAtMs == null) return { code: 'NOT_STARTED' as const };
    const receivedAt = this.now();
    const result = this.store.pathGraph().finish({
      roundId: `daily:${today.date}`, dataVersion: today.dataVersion,
      startId: today.start.id, endId: today.end.id,
      serverStartedAtMs: run.startedAtMs, serverDeadlineAtMs: today.nextRefreshAt, maxJumps: MAX_JUMPS,
    }, input.routeIds, receivedAt);
    run.attempts += 1; run.name = name;
    if (!result.valid) {
      await runStore.set(today.bucket, run);
      return { code: 'INVALID_PATH' as const, reason: result.reason, run: this.publicRun(run) };
    }
    const finish = result.finish;
    const improved = !run.best || compareCsLinkPathFinishes(finish, this.asFinish(today, run)!) < 0;
    if (improved) run.best = { jumps: finish.jumps, elapsedMs: finish.elapsedMs,
      routeIds: finish.routeIds, completedAtMs: finish.serverCompletedAtMs };
    await runStore.set(today.bucket, run);
    return { improved, finish: { jumps: finish.jumps, elapsedMs: finish.elapsedMs, routeIds: finish.routeIds,
      hops: finish.hops }, run: this.publicRun(run) };
  }

  /** 先比跳数，跳数相同比用时；用时也一样时按先完成者排前 */
  async leaderboard(key: string | null, limit: number) {
    const today = this.today();
    if (!today) return { code: 'NO_QUESTION' as const };
    const runs = await runStore.all(today.bucket);
    const done = runs.filter(run => run.best).sort((a, b) =>
      a.best!.jumps - b.best!.jumps || a.best!.elapsedMs - b.best!.elapsedMs ||
      a.best!.completedAtMs - b.best!.completedAtMs);
    const row = (run: CsLinkDailyRun, rank: number | null) => ({ rank, name: run.name,
      jumps: run.best?.jumps ?? null, elapsedMs: run.best?.elapsedMs ?? null, me: run.key === key });
    const top = done.slice(0, limit).map((run, i) => row(run, i + 1));
    const mine = key ? runs.find(run => run.key === key) : undefined;
    const myRank = mine?.best ? done.indexOf(mine) + 1 : null;
    return { date: today.date, no: today.no, players: runs.length, finished: done.length, top,
      me: mine ? { ...row(mine, myRank), startedAtMs: mine.startedAtMs, attempts: mine.attempts } : null,
      serverNowMs: this.now() };
  }

  private asFinish(today: CsLinkDailyToday, run: CsLinkDailyRun): CsLinkPathFinish | null {
    if (!run.best) return null;
    return { roundId: `daily:${today.date}`, dataVersion: today.dataVersion, startId: today.start.id,
      endId: today.end.id, routeIds: run.best.routeIds, jumps: run.best.jumps,
      serverCompletedAtMs: run.best.completedAtMs, elapsedMs: run.best.elapsedMs, hops: [] };
  }
  private publicRun(run: CsLinkDailyRun) {
    return { startedAtMs: run.startedAtMs, attempts: run.attempts, best: run.best };
  }
}

/** 测试用：清空内存存储 */
export function resetCsLinkDailyMemory() { memory.clear(); }
