import crypto from 'crypto';
import type { PlayPlayer } from './cslinkPlay';
import { CsLinkPathGraph, CsLinkPathRound, CsLinkPathFinish, compareCsLinkPathFinishes } from './cslinkPaths';
import type { StoredIdentity } from './roomStore';

export interface CsLinkRoomStore {
  pathGraph(): CsLinkPathGraph;
  getPathPlayer(id: string): PlayPlayer | null;
}
export interface CsLinkRoomFinish extends CsLinkPathFinish { route: PlayPlayer[] }
export interface CsLinkRoomResult {
  winnerKeys: string[];
  reason: 'all_incomplete' | 'one_completed' | 'fewer_jumps' | 'faster_time' | 'exact_tie';
  rankings: { key: string; name: string; rank: number | null; best: CsLinkRoomFinish | null; left: boolean }[];
}
export interface CsLinkRoomView {
  id: string; revision: number; status: 'lobby' | 'playing' | 'finished';
  hostKey: string; maxPlayers: number; durationSeconds: number;
  players: { key: string; name: string; connected: boolean; ready: boolean; left: boolean;
    best: { jumps: number; elapsedMs: number | null } | null }[];
  round: (CsLinkPathRound & { start: PlayPlayer; end: PlayPlayer }) | null;
  myBest: CsLinkRoomFinish | null;
  result: CsLinkRoomResult | null;
}
export interface CsLinkRoomReply {
  code?: string; reason?: string; improved?: boolean;
  room: CsLinkRoomView | null; meKey: string; serverNowMs: number;
}
interface Member {
  key: string; name: string; ready: boolean; left: boolean;
  best: CsLinkPathFinish | null;
  receipts: Map<string, { fingerprint: string; code?: string; reason?: string; improved?: boolean }>;
}
interface Room {
  id: string; revision: number; status: CsLinkRoomView['status']; hostKey: string;
  maxPlayers: number; durationSeconds: number; members: Member[];
  graph: CsLinkPathGraph; round: CsLinkPathRound | null; result: CsLinkRoomResult | null; touchedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
export interface CsLinkRoomOptions {
  now?: () => number;
  roomTtlMs?: number;
  maxRooms?: number;
  /** Question endpoints must pass this (e.g. players with a portrait); falls back if none qualify. */
  endpointAllowed?: (id: string) => boolean;
  /** Delay between the host pressing start and the round clock starting, for the shared countdown. */
  countdownMs?: number;
}

/** Single-process local rooms. Every round keeps the exact game graph from its creation. */
export class CsLinkRooms {
  private rooms = new Map<string, Room>();
  private membership = new Map<string, string>();
  private connections = new Map<string, Set<string>>();
  private now: () => number;
  private expiry: ReturnType<typeof setInterval>;
  private roomTtlMs: number;
  private maxRooms: number;
  private endpointAllowed?: (id: string) => boolean;
  private countdownMs: number;

  constructor(private store: CsLinkRoomStore, private changed: (keys: string[]) => void,
    options: CsLinkRoomOptions = {}) {
    this.now = options.now ?? Date.now;
    this.roomTtlMs = options.roomTtlMs ?? 60 * 60 * 1000;
    this.maxRooms = options.maxRooms ?? 100;
    this.endpointAllowed = options.endpointAllowed;
    this.countdownMs = Math.max(0, options.countdownMs ?? 0);
    this.expiry = setInterval(() => this.sweep(), 30_000);
    this.expiry.unref?.();
  }

  stop() {
    clearInterval(this.expiry);
    for (const room of this.rooms.values()) if (room.timer) clearTimeout(room.timer);
    this.rooms.clear(); this.membership.clear(); this.connections.clear();
  }

  connect(identity: StoredIdentity, socketId: string) {
    let connections = this.connections.get(identity.key);
    if (!connections) { connections = new Set(); this.connections.set(identity.key, connections); }
    connections.add(socketId);
    const room = this.roomFor(identity.key);
    if (room && !this.member(room, identity.key)?.left) this.notify(room);
  }

  disconnect(key: string, socketId: string) {
    const connections = this.connections.get(key);
    connections?.delete(socketId);
    if (!connections?.size) this.connections.delete(key);
    const room = this.roomFor(key);
    if (room) this.notify(room);
  }

  sync(key: string): CsLinkRoomReply {
    const room = this.roomFor(key);
    if (room) this.closeIfDue(room);
    return this.reply(key);
  }

  create(identity: StoredIdentity, durationSeconds = 20, maxPlayers = 2): CsLinkRoomReply {
    this.sweep();
    const existing = this.roomFor(identity.key);
    if (existing) {
      if (this.member(existing, identity.key)?.left && existing.status !== 'playing') {
        this.membership.delete(identity.key);
      } else return this.reply(identity.key, this.member(existing, identity.key)?.left ? 'LEFT_ROUND' : 'ALREADY_IN_ROOM');
    }
    if (this.rooms.size >= this.maxRooms) return this.reply(identity.key, 'ROOM_LIMIT');
    if (!Number.isInteger(durationSeconds) || durationSeconds < 20 || durationSeconds > 600 ||
        !Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 8) return this.reply(identity.key, 'VALIDATION_FAILED');
    let id: string;
    do { id = `L${crypto.randomBytes(5).toString('hex').slice(0, 5).toUpperCase()}`; } while (this.rooms.has(id));
    const room: Room = { id, revision: 0, status: 'lobby', hostKey: identity.key, maxPlayers,
      durationSeconds, members: [this.newMember(identity)], graph: this.store.pathGraph(), round: null, result: null,
      touchedAt: this.now(), timer: null };
    this.rooms.set(id, room); this.membership.set(identity.key, id); this.notify(room);
    return this.reply(identity.key);
  }

  join(identity: StoredIdentity, roomId: string): CsLinkRoomReply {
    const room = this.rooms.get(roomId);
    if (!room) return this.reply(identity.key, 'ROOM_NOT_FOUND');
    this.closeIfDue(room);
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

  start(key: string, roomId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.status !== 'lobby') return this.reply(key, 'NOT_LOBBY');
    if (room.members.length < 2) return this.reply(key, 'NOT_ENOUGH_PLAYERS');
    if (room.members.some(member => !member.ready || !this.isConnected(member.key))) return this.reply(key, 'NOT_READY');
    const pair = room.graph.sampleDistantPair(3, 6, 32, undefined, this.endpointAllowed);
    if (!pair) return this.reply(key, 'NO_QUESTION');
    const started = this.now() + this.countdownMs;
    room.round = { roundId: crypto.randomUUID(), dataVersion: room.graph.dataVersion,
      startId: pair.startId, endId: pair.endId, serverStartedAtMs: started,
      serverDeadlineAtMs: started + room.durationSeconds * 1000, maxJumps: 16 };
    room.status = 'playing'; this.armDeadline(room); this.notify(room); return this.reply(key);
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
    if (room.members.every(other => other.left || other.best)) { this.finish(room); return { ...this.reply(key), improved }; }
    this.notify(room); return { ...this.reply(key), improved };
  }

  rematch(key: string, roomId: string): CsLinkRoomReply {
    const room = this.authorized(key, roomId);
    if (!room) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    if (room.hostKey !== key) return this.reply(key, 'HOST_ONLY');
    if (room.status !== 'finished') return this.reply(key, 'NOT_FINISHED');
    for (const member of room.members.filter(member => member.left)) {
      if (this.membership.get(member.key) === room.id) this.membership.delete(member.key);
    }
    room.members = room.members.filter(member => !member.left);
    for (const member of room.members) { member.best = null; member.ready = false; member.receipts.clear(); }
    room.round = null; room.result = null; room.status = 'lobby'; this.notify(room); return this.reply(key);
  }

  leave(key: string, roomId: string): CsLinkRoomReply {
    const room = this.roomFor(key);
    if (!room || room.id !== roomId) return this.reply(key, 'NOT_IN_ROOM');
    this.closeIfDue(room);
    const member = this.member(room, key)!;
    if (room.status === 'lobby') {
      room.members = room.members.filter(member => member.key !== key); this.membership.delete(key);
    } else { member.left = true; member.ready = false; }
    if (room.hostKey === key) room.hostKey = room.members.find(member => !member.left)?.key ?? key;
    if (!room.members.some(member => !member.left)) {
      if (room.status === 'playing') this.finish(room);
      else this.deleteRoom(room);
    } else this.notify(room);
    this.changed([key]); return this.reply(key);
  }

  private newMember(identity: StoredIdentity): Member {
    return { key: identity.key, name: identity.name, ready: false, left: false, best: null, receipts: new Map() };
  }
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
    if (room.timer) clearTimeout(room.timer);
    room.timer = null; this.notify(room);
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
      key: row.member.key, name: row.member.name, left: row.member.left,
      rank: row.best ? ranked.findIndex(other => other.best && compareCsLinkPathFinishes(other.best, row.best!) === 0) + 1 : null,
      best: this.fullFinish(row.best),
    })) };
  }
  private reply(key: string, code?: string): CsLinkRoomReply {
    const room = this.roomFor(key), member = room && this.member(room, key);
    const view: CsLinkRoomView | null = room && member && !member.left ? {
      id: room.id, revision: room.revision, status: room.status, hostKey: room.hostKey,
      maxPlayers: room.maxPlayers, durationSeconds: room.durationSeconds,
      players: room.members.map(member => ({ key: member.key, name: member.name,
        ready: member.ready, left: member.left, connected: !member.left && this.isConnected(member.key),
        best: member.best ? { jumps: member.best.jumps,
          // Mid-round, opponents only see jump counts; times are revealed with the result.
          elapsedMs: room.status === 'playing' && member.key !== key ? null : member.best.elapsedMs } : null })),
      round: room.round ? { ...room.round, start: this.store.getPathPlayer(room.round.startId)!,
        end: this.store.getPathPlayer(room.round.endId)! } : null,
      myBest: this.fullFinish(member.best), result: room.result,
    } : null;
    return { ...(code ? { code } : {}), room: view, meKey: key, serverNowMs: this.now() };
  }
  private deleteRoom(room: Room) {
    if (room.timer) clearTimeout(room.timer);
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
