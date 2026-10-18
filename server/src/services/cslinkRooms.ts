import crypto from 'crypto';
import type { PlayPlayer } from './cslinkPlay';
import { CsLinkPathGraph, CsLinkPathRound, CsLinkPathFinish, CsLinkPathHop, compareCsLinkPathFinishes } from './cslinkPaths';
import type { StoredIdentity } from './roomStore';
import { CSLINK_DIFFICULTIES, DEFAULT_CSLINK_DIFFICULTY, isCsLinkDifficulty,
  type CsLinkDifficulty, type CsLinkDifficultyFilters } from './cslinkDifficulty';
import type { CsLinkLadder } from './cslinkLadder';

/** 天梯房固定参数：玩家点一下就开打，不用设置。 */
export const CSLINK_RANKED = { durationSeconds: 20, targetScore: 3, difficulty: 'normal' as CsLinkDifficulty };

export interface CsLinkRoomStore {
  pathGraph(): CsLinkPathGraph;
  getPathPlayer(id: string): PlayPlayer | null;
}
export interface CsLinkRoomFinish extends CsLinkPathFinish { route: PlayPlayer[] }
/** One shortest route for the round, published with the result so nobody leaves without the answer. */
export interface CsLinkRoomAnswer { routeIds: string[]; jumps: number; hops: CsLinkPathHop[]; route: PlayPlayer[] }
export interface CsLinkRoomResult {
  winnerKeys: string[];
  reason: 'all_incomplete' | 'one_completed' | 'fewer_jumps' | 'faster_time' | 'exact_tie';
  rankings: { key: string; name: string; rank: number | null; best: CsLinkRoomFinish | null; left: boolean; gaveUp: boolean }[];
  answer: CsLinkRoomAnswer | null;
}
export interface CsLinkRoomView {
  id: string; revision: number; status: 'lobby' | 'playing' | 'finished';
  hostKey: string; maxPlayers: number; durationSeconds: number;
  difficulty: CsLinkDifficulty;
  /** First to this many round wins takes the match. */
  targetScore: number; matchOver: boolean;
  /** Round number within the current match (1-based; 0 before the first round). */
  roundNo: number;
  /** When the next round of an unfinished match starts automatically; null otherwise. */
  nextRoundAtMs: number | null;
  /** Players who have not opened the duel page yet for the current round. */
  waitingKeys: string[];
  /** Matchmade room: fixed options, Elo settled when the match ends. */
  ranked: boolean;
  /** Ladder rating change per player key, once a ranked match is settled. */
  ladderDelta: Record<string, number> | null;
  players: { key: string; name: string; connected: boolean; ready: boolean; left: boolean;
    score: number; gaveUp: boolean; rating: number | null; best: { jumps: number; elapsedMs: number | null } | null }[];
  round: (CsLinkPathRound & { start: PlayPlayer; end: PlayPlayer }) | null;
  myBest: CsLinkRoomFinish | null;
  result: CsLinkRoomResult | null;
}
export interface CsLinkRoomReply {
  code?: string; reason?: string; improved?: boolean;
  room: CsLinkRoomView | null; meKey: string; serverNowMs: number;
  /** Present while this identity waits in the ladder queue. */
  queue?: { sinceMs: number; waiting: number };
}
interface Member {
  key: string; name: string; ready: boolean; left: boolean; score: number; gaveUp: boolean;
  best: CsLinkPathFinish | null;
  receipts: Map<string, { fingerprint: string; code?: string; reason?: string; improved?: boolean }>;
}
interface Room {
  id: string; revision: number; status: CsLinkRoomView['status']; hostKey: string;
  maxPlayers: number; durationSeconds: number; members: Member[];
  difficulty: CsLinkDifficulty;
  targetScore: number; matchOver: boolean; arrivals: Set<string>;
  roundNo: number; nextRoundAtMs: number | null; nextTimer: ReturnType<typeof setTimeout> | null;
  graph: CsLinkPathGraph; round: CsLinkPathRound | null; result: CsLinkRoomResult | null; touchedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  ranked: boolean; forfeitKey: string | null; idleRounds: number; ladderDelta: Record<string, number> | null;
}
export interface CsLinkRoomOptions {
  now?: () => number;
  roomTtlMs?: number;
  maxRooms?: number;
  /** Question endpoints must pass this (e.g. players with a portrait); falls back if none qualify. */
  endpointAllowed?: (id: string) => boolean;
  /** Per-difficulty endpoint filters (popularity tiers); falls back to endpointAllowed when absent. */
  difficultyFilters?: CsLinkDifficultyFilters;
  /** Delay between the host pressing start and the round clock starting, for the shared countdown. */
  countdownMs?: number;
  /** Extra time allowed for everyone to load the duel page; the clock starts early once all have arrived. */
  arrivalGraceMs?: number;
  /** Pause between rounds of an unfinished match before the next one starts by itself. */
  interRoundMs?: number;
  /** How long a lobby seat survives without any live socket before it is freed. */
  lobbyDropMs?: number;
  /** Elo store for matchmade rooms; ratings are hidden when absent. */
  ladder?: CsLinkLadder;
}

/** Single-process local rooms. Every round keeps the exact game graph from its creation. */
export class CsLinkRooms {
  private rooms = new Map<string, Room>();
  private membership = new Map<string, string>();
  private connections = new Map<string, Set<string>>();
  private dropTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private waiting: { identity: StoredIdentity; sinceMs: number }[] = [];
  private ladder?: CsLinkLadder;
  private lobbyDropMs: number;
  private now: () => number;
  private expiry: ReturnType<typeof setInterval>;
  private roomTtlMs: number;
  private maxRooms: number;
  private endpointAllowed?: (id: string) => boolean;
  private difficultyFilters?: CsLinkDifficultyFilters;
  private countdownMs: number;
  private arrivalGraceMs: number;
  /** null disables automatic next rounds; the host can still use nextRound / rematch. */
  private interRoundMs: number | null;

  constructor(private store: CsLinkRoomStore, private changed: (keys: string[]) => void,
    options: CsLinkRoomOptions = {}) {
    this.now = options.now ?? Date.now;
    this.roomTtlMs = options.roomTtlMs ?? 60 * 60 * 1000;
    this.maxRooms = options.maxRooms ?? 100;
    this.endpointAllowed = options.endpointAllowed;
    this.difficultyFilters = options.difficultyFilters;
    this.countdownMs = Math.max(0, options.countdownMs ?? 0);
    this.arrivalGraceMs = Math.max(0, options.arrivalGraceMs ?? 0);
    this.interRoundMs = options.interRoundMs === undefined ? null : Math.max(0, options.interRoundMs);
    this.lobbyDropMs = Math.max(0, options.lobbyDropMs ?? 15_000);
    this.ladder = options.ladder;
    this.expiry = setInterval(() => this.sweep(), 30_000);
    this.expiry.unref?.();
  }

  stop() {
    clearInterval(this.expiry);
    for (const timer of this.dropTimers.values()) clearTimeout(timer);
    this.dropTimers.clear();
    for (const room of this.rooms.values()) { if (room.timer) clearTimeout(room.timer); this.cancelNext(room); }
    this.rooms.clear(); this.membership.clear(); this.connections.clear(); this.waiting = [];
  }

  connect(identity: StoredIdentity, socketId: string) {
    let connections = this.connections.get(identity.key);
    if (!connections) { connections = new Set(); this.connections.set(identity.key, connections); }
    connections.add(socketId);
    const pending = this.dropTimers.get(identity.key);
    if (pending) { clearTimeout(pending); this.dropTimers.delete(identity.key); }
    const room = this.roomFor(identity.key);
    if (room && !this.member(room, identity.key)?.left) this.notify(room);
  }

  disconnect(key: string, socketId: string) {
    const connections = this.connections.get(key);
    connections?.delete(socketId);
    if (!connections?.size) this.connections.delete(key);
    // 匹配中关掉页面就出队，免得配到一个不在的人
    if (!connections?.size && this.waiting.some(entry => entry.identity.key === key)) {
      this.waiting = this.waiting.filter(entry => entry.identity.key !== key);
    }
    const room = this.roomFor(key);
    if (room) this.notify(room);
    // A lobby seat held by someone who closed the tab would block start() forever; free it after a grace period.
    if (room && room.status === 'lobby' && !this.isConnected(key) && !this.dropTimers.has(key)) {
      const timer = setTimeout(() => {
        this.dropTimers.delete(key);
        const current = this.roomFor(key);
        if (current && current.status === 'lobby' && !this.isConnected(key)) this.leave(key, current.id);
      }, this.lobbyDropMs);
      timer.unref?.();
      this.dropTimers.set(key, timer);
    }
  }

  sync(key: string): CsLinkRoomReply {
    const room = this.roomFor(key);
    if (room) this.closeIfDue(room);
    return this.reply(key);
  }

  create(identity: StoredIdentity, durationSeconds = 20, maxPlayers = 2, targetScore = 3,
    difficulty: CsLinkDifficulty = DEFAULT_CSLINK_DIFFICULTY): CsLinkRoomReply {
    this.sweep();
    this.releaseSettled(identity.key); this.dropFromQueue(identity.key);
    const existing = this.roomFor(identity.key);
    if (existing) {
      if (this.member(existing, identity.key)?.left && existing.status !== 'playing') {
        this.membership.delete(identity.key);
      } else return this.reply(identity.key, this.member(existing, identity.key)?.left ? 'LEFT_ROUND' : 'ALREADY_IN_ROOM');
    }
    if (this.rooms.size >= this.maxRooms) return this.reply(identity.key, 'ROOM_LIMIT');
    if (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > 600 ||
        !Number.isInteger(targetScore) || targetScore < 1 || targetScore > 10 ||
        !isCsLinkDifficulty(difficulty) ||
        !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8) return this.reply(identity.key, 'VALIDATION_FAILED');
    let id: string;
    do { id = `L${crypto.randomBytes(5).toString('hex').slice(0, 5).toUpperCase()}`; } while (this.rooms.has(id));
    const room = this.newRoom(id, identity, durationSeconds, maxPlayers, targetScore, difficulty, false);
    this.rooms.set(id, room); this.membership.set(identity.key, id); this.notify(room);
    return this.reply(identity.key);
  }

  /** 天梯匹配：排队的人先到先配，凑够两人直接开打。 */
  queue(identity: StoredIdentity): CsLinkRoomReply {
    this.sweep();
    this.releaseSettled(identity.key);
    const existing = this.roomFor(identity.key);
    if (existing) {
      if (this.member(existing, identity.key)?.left && existing.status !== 'playing') this.membership.delete(identity.key);
      else return this.reply(identity.key, this.member(existing, identity.key)?.left ? 'LEFT_ROUND' : 'ALREADY_IN_ROOM');
    }
    if (this.waiting.some(entry => entry.identity.key === identity.key)) return this.reply(identity.key);
    this.waiting = this.waiting.filter(entry => this.isConnected(entry.identity.key));
    const opponent = this.waiting.shift();
    if (!opponent) {
      this.waiting.push({ identity, sinceMs: this.now() });
      return this.reply(identity.key);
    }
    if (this.rooms.size >= this.maxRooms) { this.waiting.unshift(opponent); return this.reply(identity.key, 'ROOM_LIMIT'); }
    let id: string;
    do { id = `L${crypto.randomBytes(5).toString('hex').slice(0, 5).toUpperCase()}`; } while (this.rooms.has(id));
    const room = this.newRoom(id, opponent.identity, CSLINK_RANKED.durationSeconds, 2, CSLINK_RANKED.targetScore,
      CSLINK_RANKED.difficulty, true);
    room.members.push(this.newMember(identity));
    for (const member of room.members) { member.ready = true; this.membership.set(member.key, id); }
    this.rooms.set(id, room);
    const code = this.beginRound(room);
    if (code) { this.deleteRoom(room); this.waiting.unshift(opponent); return this.reply(identity.key, code); }
    return this.reply(identity.key);
  }

  unqueue(key: string): CsLinkRoomReply { this.dropFromQueue(key); return this.reply(key); }

  join(identity: StoredIdentity, roomId: string): CsLinkRoomReply {
    const room = this.rooms.get(roomId);
    if (!room) return this.reply(identity.key, 'ROOM_NOT_FOUND');
    this.closeIfDue(room);
    this.releaseSettled(identity.key); this.dropFromQueue(identity.key);
    const existing = this.roomFor(identity.key);
    if (existing) {
      const member = this.member(existing, identity.key)!;
      if (!member.left) return this.reply(identity.key, existing.id === roomId ? undefined : 'ALREADY_IN_ROOM');
      if (existing.status === 'playing') return this.reply(identity.key, 'LEFT_ROUND');
      this.membership.delete(identity.key);
    }
    if (room.status !== 'lobby') return this.reply(identity.key, 'ROOM_NOT_JOINABLE');
    if (room.members.length >= room.maxPlayers) return this.reply(identity.key, 'ROOM_FULL');
    room.members.push(this.newMember(identity)); this.membership.set(identity.key, roomId);
    this.notify(room); return this.reply(identity.key);
  }

  ready(key: string, roomId: string, ready: boolean): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    if (room.status !== 'lobby') return this.reply(key, 'NOT_LOBBY');
    this.member(room, key)!.ready = ready; this.notify(room); return this.reply(key);
  }

  /** Host changes round length or target score between rounds. Changing the target restarts the match score. */
  setOptions(key: string, roomId: string,
    input: { durationSeconds?: number; targetScore?: number; difficulty?: CsLinkDifficulty }): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.ranked) return this.reply(key, 'RANKED_FIXED');
    if (room.status !== 'lobby') return this.reply(key, 'NOT_LOBBY');
    const { durationSeconds, targetScore, difficulty } = input;
    if (durationSeconds !== undefined && (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > 600)) return this.reply(key, 'VALIDATION_FAILED');
    if (targetScore !== undefined && (!Number.isInteger(targetScore) || targetScore < 1 || targetScore > 10)) return this.reply(key, 'VALIDATION_FAILED');
    if (difficulty !== undefined && !isCsLinkDifficulty(difficulty)) return this.reply(key, 'VALIDATION_FAILED');
    if (durationSeconds !== undefined) room.durationSeconds = durationSeconds;
    if (difficulty !== undefined) room.difficulty = difficulty;
    if (targetScore !== undefined && targetScore !== room.targetScore) {
      room.targetScore = targetScore; room.matchOver = false;
      for (const member of room.members) member.score = 0;
    }
    this.notify(room); return this.reply(key);
  }

  /** The duel page reports it has loaded. When everyone is in, the clock starts after the short countdown. */
  arrive(key: string, roomId: string, roundId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    if (room.status !== 'playing' || !room.round || room.round.roundId !== roundId) return this.reply(key);
    if (room.arrivals.has(key)) return this.reply(key);
    room.arrivals.add(key);
    if (room.members.every(member => member.left || room.arrivals.has(member.key))) {
      const startAt = this.now() + this.countdownMs;
      if (startAt < room.round.serverStartedAtMs) {
        const shift = room.round.serverStartedAtMs - startAt;
        room.round = { ...room.round, serverStartedAtMs: startAt, serverDeadlineAtMs: room.round.serverDeadlineAtMs - shift };
        this.armDeadline(room);
      }
    }
    this.notify(room); return this.reply(key);
  }

  start(key: string, roomId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.status !== 'lobby') return this.reply(key, 'NOT_LOBBY');
    if (room.members.length < 2) return this.reply(key, 'NOT_ENOUGH_PLAYERS');
    if (room.members.some(member => !member.ready || !this.isConnected(member.key))) return this.reply(key, 'NOT_READY');
    const code = this.beginRound(room);
    return this.reply(key, code);
  }

  /** Host skips the pause between rounds of an unfinished match. */
  nextRound(key: string, roomId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.status !== 'finished' || room.matchOver) return this.reply(key, 'NOT_FINISHED');
    this.autoNext(room);
    return this.reply(key);
  }

  /** Draws a fresh question and starts the clock flow; members must already be reset. */
  private beginRound(room: Room): string | undefined {
    const tier = CSLINK_DIFFICULTIES[room.difficulty];
    const filter = this.difficultyFilters?.[room.difficulty];
    const pair = filter
      ? room.graph.sampleDistantPair(tier.minJumps, tier.maxJumps, 32, undefined, filter, `tier:${room.difficulty}`)
      : room.graph.sampleDistantPair(tier.minJumps, tier.maxJumps, 32, undefined, this.endpointAllowed);
    if (!pair) return 'NO_QUESTION';
    // Upper bound while people load the duel page; arrive() pulls it forward once everyone is in.
    const started = this.now() + this.countdownMs + this.arrivalGraceMs;
    room.arrivals = new Set();
    room.round = { roundId: crypto.randomUUID(), dataVersion: room.graph.dataVersion,
      startId: pair.startId, endId: pair.endId, serverStartedAtMs: started,
      serverDeadlineAtMs: started + room.durationSeconds * 1000, maxJumps: 16 };
    room.roundNo++; room.result = null;
    room.status = 'playing'; this.armDeadline(room); this.notify(room); return undefined;
  }

  submit(key: string, input: { roomId: string; roundId: string; dataVersion: string;
    routeIds: string[]; eventId: string }, receivedAt: number): CsLinkRoomReply {
    const room = this.authorized(key, input.roomId);
    if (!room) return this.reply(key, this.roomFor(key) && this.member(this.roomFor(key)!, key)?.left ? 'LEFT_ROUND' : 'NOT_IN_ROOM');
    const member = this.member(room, key)!;
    if (!room.round || room.round.roundId !== input.roundId) return this.reply(key, 'ROUND_MISMATCH');
    if (room.round.dataVersion !== input.dataVersion) return this.reply(key, 'VERSION_MISMATCH');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([input.roundId, input.dataVersion, input.routeIds])).digest('hex');
    const prior = member.receipts.get(input.eventId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return this.reply(key, 'EVENT_ID_CONFLICT');
      return { ...this.reply(key, prior.code), reason: prior.reason, improved: prior.improved };
    }
    if (member.receipts.size >= 1024) return this.reply(key, 'TOO_MANY_SUBMISSIONS');
    if (member.gaveUp) return this.reply(key, 'GAVE_UP');
    if (receivedAt > room.round.serverDeadlineAtMs || room.status === 'finished') {
      this.closeIfDue(room); return this.reply(key, 'ROUND_EXPIRED');
    }
    if (room.status !== 'playing') return this.reply(key, 'NOT_PLAYING');
    const result = room.graph.finish(room.round, input.routeIds, receivedAt);
    if (!result.valid) {
      member.receipts.set(input.eventId, { fingerprint, code: 'INVALID_PATH', reason: result.reason });
      return { ...this.reply(key, 'INVALID_PATH'), reason: result.reason };
    }
    const improved = !member.best || compareCsLinkPathFinishes(result.finish, member.best) < 0;
    if (improved) member.best = result.finish;
    member.receipts.set(input.eventId, { fingerprint, improved });
    // Everyone still in the round has connected: settle now instead of idling until the deadline.
    if (this.allDone(room)) { this.finish(room); return { ...this.reply(key), improved }; }
    this.notify(room); return { ...this.reply(key), improved };
  }

  /** Player stops trying this round. Only possible before connecting; it cannot be undone within the round. */
  giveUp(key: string, roomId: string, roundId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    if (room.status !== 'playing' || !room.round) return this.reply(key, 'NOT_PLAYING');
    if (room.round.roundId !== roundId) return this.reply(key, 'ROUND_MISMATCH');
    const member = this.member(room, key)!;
    if (member.best) return this.reply(key, 'ALREADY_CONNECTED');
    if (member.gaveUp) return this.reply(key);
    member.gaveUp = true;
    if (this.allDone(room)) this.finish(room); else this.notify(room);
    return this.reply(key);
  }

  rematch(key: string, roomId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.ranked) return this.reply(key, 'RANKED_FIXED');
    if (room.status !== 'finished') return this.reply(key, 'NOT_FINISHED');
    this.toLobby(room); return this.reply(key);
  }

  leave(key: string, roomId: string): CsLinkRoomReply {
    const room = this.roomFor(key);
    if (!room || room.id !== roomId) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    const member = this.member(room, key)!;
    // 天梯局中途走人算认输
    if (room.ranked && !room.ladderDelta && room.status !== 'lobby' && !member.left) {
      room.forfeitKey = key;
      if (room.status === 'finished') { room.matchOver = true; this.cancelNext(room); this.settle(room); }
    }
    if (room.status === 'lobby') {
      room.members = room.members.filter(member => member.key !== key); this.membership.delete(key);
    } else { member.left = true; member.ready = false; }
    if (room.hostKey === key) room.hostKey = room.members.find(member => !member.left)?.key ?? key;
    if (!room.members.some(member => !member.left)) {
      if (room.status === 'playing') this.finish(room);
      else this.deleteRoom(room);
    } else if (room.ranked && room.status === 'playing') this.finish(room);
    else this.notify(room);
    this.changed([key]); return this.reply(key);
  }

  private newMember(identity: StoredIdentity): Member {
    return { key: identity.key, name: identity.name, ready: false, left: false, score: 0, gaveUp: false, best: null, receipts: new Map() };
  }
  private newRoom(id: string, host: StoredIdentity, durationSeconds: number, maxPlayers: number, targetScore: number,
    difficulty: CsLinkDifficulty, ranked: boolean): Room {
    return { id, revision: 0, status: 'lobby', hostKey: host.key, maxPlayers,
      durationSeconds, difficulty, targetScore, matchOver: false, arrivals: new Set(),
      roundNo: 0, nextRoundAtMs: null, nextTimer: null,
      members: [this.newMember(host)], graph: this.store.pathGraph(), round: null, result: null,
      touchedAt: this.now(), timer: null, ranked, forfeitKey: null, idleRounds: 0, ladderDelta: null };
  }
  private dropFromQueue(key: string) { this.waiting = this.waiting.filter(entry => entry.identity.key !== key); }
  /** 已结算的天梯房不再占着人：再点匹配 / 建房时自动离座。 */
  private releaseSettled(key: string) {
    const room = this.roomFor(key);
    if (room?.ranked && room.matchOver && room.status === 'finished') this.leave(key, room.id);
  }
  /** Elo：$S_A$ 取 1 / 0.5 / 0，按整场比分（或认输）定。 */
  private settle(room: Room) {
    if (!room.ranked || room.ladderDelta || !this.ladder || room.members.length !== 2) return;
    const [a, b] = room.members;
    const scoreA: 0 | 0.5 | 1 = room.forfeitKey === a.key ? 0 : room.forfeitKey === b.key ? 1
      : a.score > b.score ? 1 : a.score < b.score ? 0 : 0.5;
    room.ladderDelta = this.ladder.settle({ key: a.key, name: a.name }, { key: b.key, name: b.name }, scoreA);
  }
  private pruneAndReset(room: Room) {
    for (const member of room.members.filter(member => member.left)) {
      if (this.membership.get(member.key) === room.id) this.membership.delete(member.key);
    }
    room.members = room.members.filter(member => !member.left);
    for (const member of room.members) { member.best = null; member.gaveUp = false; member.receipts.clear(); }
    room.arrivals = new Set();
  }
  private toLobby(room: Room) {
    this.cancelNext(room);
    this.pruneAndReset(room);
    if (room.matchOver) { room.matchOver = false; room.roundNo = 0; for (const member of room.members) member.score = 0; }
    for (const member of room.members) member.ready = false;
    room.round = null; room.result = null; room.status = 'lobby'; this.notify(room);
  }
  private cancelNext(room: Room) {
    if (room.nextTimer) clearTimeout(room.nextTimer);
    room.nextTimer = null; room.nextRoundAtMs = null;
  }
  /** Next round of the same match: scores stay, nobody has to ready up again. */
  private autoNext(room: Room) {
    this.cancelNext(room);
    if (!this.rooms.has(room.id) || room.status !== 'finished' || room.matchOver) return;
    if (room.members.filter(member => !member.left).length < 2) { this.toLobby(room); return; }
    this.pruneAndReset(room);
    if (this.beginRound(room)) this.toLobby(room);
  }
  private allDone(room: Room) { return room.members.every(member => member.left || member.best || member.gaveUp); }
  private roomFor(key: string) { return this.rooms.get(this.membership.get(key) ?? ''); }
  private member(room: Room, key: string) { return room.members.find(member => member.key === key); }
  private authorized(key: string, roomId: string) {
    const room = this.roomFor(key);
    return room?.id === roomId && !this.member(room, key)?.left ? room : undefined;
  }
  private isConnected(key: string) { return Boolean(this.connections.get(key)?.size); }
  private notify(room: Room) {
    room.revision++; room.touchedAt = this.now(); this.changed(room.members.map(member => member.key));
  }
  private closeIfDue(room: Room) {
    if (room.status === 'playing' && room.round && this.now() > room.round.serverDeadlineAtMs) this.finish(room);
  }
  private armDeadline(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      room.timer = null;
      this.closeIfDue(room);
      if (room.status === 'playing') this.armDeadline(room);
    }, Math.max(1, room.round!.serverDeadlineAtMs - this.now() + 1));
    room.timer.unref?.();
  }
  private finish(room: Room) {
    if (room.status !== 'playing') return;
    room.status = 'finished';
    room.result = this.result(room);
    for (const member of room.members) if (room.result.winnerKeys.includes(member.key)) member.score++;
    room.matchOver = room.members.some(member => !member.left && member.score >= room.targetScore);
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const pause = this.interRoundMs;
    // 全员挂机（没交过路线也没放弃）就不再自动续局，免得空房一直循环
    const active = room.members.filter(member => !member.left);
    const anyoneTried = active.some(member => member.gaveUp || member.receipts.size > 0);
    if (room.ranked) {
      // 天梯房：有人走了或连续两局没人动，整场就此结束
      room.idleRounds = anyoneTried ? 0 : room.idleRounds + 1;
      if (room.forfeitKey || active.length < 2 || room.idleRounds >= 2) room.matchOver = true;
      if (room.matchOver) this.settle(room);
    }
    if (pause !== null && !room.matchOver && active.length >= 2 && (anyoneTried || room.ranked)) {
      room.nextRoundAtMs = this.now() + pause;
      room.nextTimer = setTimeout(() => this.autoNext(room), pause);
      room.nextTimer.unref?.();
    }
    this.notify(room);
  }
  private fullFinish(finish: CsLinkPathFinish | null): CsLinkRoomFinish | null {
    return finish ? { ...finish, routeIds: [...finish.routeIds], hops: finish.hops.map(hop => ({
      ...hop, evidence: { ...hop.evidence } })), route: finish.routeIds.map(id => this.store.getPathPlayer(id)!) } : null;
  }
  private result(room: Room): CsLinkRoomResult {
    const ranked = room.members.map(member => ({ member, best: member.left ? null : member.best }))
      .sort((a, b) => a.best && b.best ? compareCsLinkPathFinishes(a.best, b.best) : a.best ? -1 : b.best ? 1 : 0);
    const finished = ranked.filter(member => member.best);
    const best = finished[0]?.best;
    const winnerKeys = best ? finished.filter(row => compareCsLinkPathFinishes(row.best!, best) === 0).map(row => row.member.key) : [];
    let reason: CsLinkRoomResult['reason'] = 'all_incomplete';
    if (finished.length === 1) reason = 'one_completed';
    else if (winnerKeys.length > 1) reason = 'exact_tie';
    else if (finished.length > 1) reason = finished[0].best!.jumps !== finished[1].best!.jumps ? 'fewer_jumps' : 'faster_time';
    return { winnerKeys, reason, rankings: ranked.map((row, index) => ({
      key: row.member.key, name: row.member.name, left: row.member.left, gaveUp: row.member.gaveUp,
      rank: row.best ? ranked.findIndex(other => other.best && compareCsLinkPathFinishes(other.best, row.best!) === 0) + 1 : null,
      best: this.fullFinish(row.best),
    })), answer: this.answer(room) };
  }
  /** Prefer intermediates players can actually search for; fall back to any proven route. */
  private answer(room: Room): CsLinkRoomAnswer | null {
    if (!room.round) return null;
    const { startId, endId } = room.round;
    const found = (this.endpointAllowed && room.graph.shortestRoute(startId, endId, this.endpointAllowed))
      || room.graph.shortestRoute(startId, endId);
    if (!found) return null;
    const route = found.routeIds.map(id => this.store.getPathPlayer(id));
    if (route.some(player => !player)) return null;
    return { routeIds: found.routeIds, jumps: found.routeIds.length - 1, hops: found.hops, route: route as PlayPlayer[] };
  }
  private reply(key: string, code?: string): CsLinkRoomReply {
    const room = this.roomFor(key), member = room && this.member(room, key);
    const view: CsLinkRoomView | null = room && member && !member.left ? {
      id: room.id, revision: room.revision, status: room.status, hostKey: room.hostKey,
      maxPlayers: room.maxPlayers, durationSeconds: room.durationSeconds,
      difficulty: room.difficulty,
      targetScore: room.targetScore, matchOver: room.matchOver,
      roundNo: room.roundNo, nextRoundAtMs: room.nextRoundAtMs,
      waitingKeys: room.status === 'playing' ? room.members.filter(other => !other.left && !room.arrivals.has(other.key)).map(other => other.key) : [],
      ranked: room.ranked, ladderDelta: room.ladderDelta,
      players: room.members.map(member => ({ key: member.key, name: member.name,
        rating: this.ladder ? this.ladder.rating(member.key) : null,
        ready: member.ready, left: member.left, score: member.score, gaveUp: member.gaveUp, connected: !member.left && this.isConnected(member.key),
        best: member.best ? { jumps: member.best.jumps,
          // Mid-round, opponents only see jump counts; times are revealed with the result.
          elapsedMs: room.status === 'playing' && member.key !== key ? null : member.best.elapsedMs } : null })),
      round: room.round ? { ...room.round, start: this.store.getPathPlayer(room.round.startId)!,
        end: this.store.getPathPlayer(room.round.endId)! } : null,
      myBest: this.fullFinish(member.best), result: room.result,
    } : null;
    const queued = this.waiting.find(entry => entry.identity.key === key);
    return { ...(code ? { code } : {}), room: view, meKey: key, serverNowMs: this.now(),
      ...(queued ? { queue: { sinceMs: queued.sinceMs, waiting: this.waiting.length } } : {}) };
  }
  private deleteRoom(room: Room) {
    if (room.timer) clearTimeout(room.timer);
    this.cancelNext(room);
    this.rooms.delete(room.id);
    for (const member of room.members) if (this.membership.get(member.key) === room.id) this.membership.delete(member.key);
    this.changed(room.members.map(member => member.key));
  }
  private sweep() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      this.closeIfDue(room);
      if (room.status !== 'playing' && now - room.touchedAt >= this.roomTtlMs) this.deleteRoom(room);
    }
  }
}
