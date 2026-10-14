import crypto from 'crypto';
import type { VerifiedLink } from './cslinkQuestions';

/** An already validated same-map lineup from any current game data source. */
export interface CsLinkPathLink {
  a: string;
  b: string;
  evidenceCount: number;
  proof: {
    mapId: number;
    sourceUrl: string;
    sourceFingerprint: string;
    lineup: readonly { id: string }[];
  };
}

export interface CsLinkPathRound {
  roundId: string;
  dataVersion: string;
  startId: string;
  endId: string;
  serverStartedAtMs: number;
  serverDeadlineAtMs: number;
  maxJumps: number;
}

export interface CsLinkPathHop {
  fromId: string;
  toId: string;
  evidence: { mapId: number; sourceUrl: string; recordSha256: string; evidenceCount: number };
}

export interface CsLinkPathFinish {
  roundId: string;
  dataVersion: string;
  startId: string;
  endId: string;
  routeIds: string[];
  jumps: number;
  serverCompletedAtMs: number;
  elapsedMs: number;
  hops: CsLinkPathHop[];
}

export type CsLinkPathFailure = 'version_changed' | 'invalid_time' | 'after_deadline' |
  'wrong_endpoints' | 'too_many_jumps' | 'repeated_player' | 'unknown_player' | 'unverified_jump';

export type CsLinkPathResult =
  | { valid: true; finish: CsLinkPathFinish }
  | { valid: false; reason: CsLinkPathFailure };

const edgeKey = (a: string, b: string) => [a, b].sort().join('|');
const validTimestamp = (n: number) => Number.isSafeInteger(n) && n >= 0;
const stablePlayerId = (id: string) => /^(?:cs-person-\d{6,}|hltv:[1-9]\d*|legacy:[a-f0-9]{20})$/.test(id);
const mapUrl = /^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\/(\d+)\/[^/?#\s]+\/?$/;

/** A fixed graph of same-map appearances, keyed only by stable, case-sensitive player IDs. */
export class CsLinkPathGraph {
  private readonly links = new Map<string, Readonly<CsLinkPathHop['evidence']>>();
  private readonly neighbors = new Map<string, Set<string>>();
  private readonly absentDistanceRanges = new Set<string>();

  constructor(readonly dataVersion: string, links: readonly (VerifiedLink | CsLinkPathLink)[]) {
    if (!dataVersion) throw new Error('CSLINK_PATH_INVALID_VERSION');
    for (const link of links) {
      const proof = link.proof;
      const recordSha256 = 'sourceFingerprint' in proof ? proof.sourceFingerprint : proof.recordSha256;
      const sourceMap = typeof proof.sourceUrl === 'string' ? mapUrl.exec(proof.sourceUrl) : null;
      if (!stablePlayerId(link.a) || !stablePlayerId(link.b) || link.a === link.b ||
          this.links.has(edgeKey(link.a, link.b)) ||
          !Number.isSafeInteger(link.evidenceCount) || link.evidenceCount < 1 ||
          !Number.isSafeInteger(proof.mapId) || proof.mapId < 1 ||
          !sourceMap || Number(sourceMap[1]) !== proof.mapId ||
          !/^[a-f0-9]{64}$/.test(recordSha256) ||
          ('review' in proof && proof.review.status !== 'verified') ||
          !Array.isArray(proof.lineup) ||
          new Set(proof.lineup.map(player => player.id)).size !== proof.lineup.length ||
          proof.lineup.some(player => !stablePlayerId(player.id)) ||
          !proof.lineup.some(player => player.id === link.a) ||
          !proof.lineup.some(player => player.id === link.b)) {
        throw new Error('CSLINK_PATH_INVALID_EDGE');
      }
      // Copy scalar proof fields so caller mutations cannot change a pinned graph after construction.
      this.links.set(edgeKey(link.a, link.b), Object.freeze({
        mapId: proof.mapId, sourceUrl: proof.sourceUrl,
        recordSha256, evidenceCount: link.evidenceCount,
      }));
      for (const [from, to] of [[link.a, link.b], [link.b, link.a]]) {
        if (!this.neighbors.has(from)) this.neighbors.set(from, new Set());
        this.neighbors.get(from)!.add(to);
      }
    }
  }

  /** A missing path means only "not connected in this game snapshot". */
  shortestJumps(startId: string, endId: string): number | null {
    if (!this.neighbors.has(startId) || !this.neighbors.has(endId)) return null;
    if (startId === endId) return 0;
    const distances = new Map<string, number>([[startId, 0]]);
    const queue = [startId];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i], nextDistance = distances.get(current)! + 1;
      for (const neighbor of this.neighbors.get(current)!) {
        if (distances.has(neighbor)) continue;
        if (neighbor === endId) return nextDistance;
        distances.set(neighbor, nextDistance);
        queue.push(neighbor);
      }
    }
    return null;
  }

  /** Try random starts first; search remaining starts only if needed so null proves no qualifying pair. */
  sampleDistantPair(minJumps = 3, maxJumps = 6, maxSources = 32,
    randomInt: (maxExclusive: number) => number = crypto.randomInt,
    endpointAllowed?: (id: string) => boolean):
    { startId: string; endId: string; shortestJumps: number; dataVersion: string } | null {
    if (!Number.isSafeInteger(minJumps) || !Number.isSafeInteger(maxJumps) ||
        !Number.isSafeInteger(maxSources) || minJumps < 2 || maxJumps < minJumps || maxSources < 1) {
      throw new Error('CSLINK_PATH_INVALID_DISTANCE_RANGE');
    }
    const rangeKey = `${minJumps}:${maxJumps}:${endpointAllowed ? 'filtered' : 'all'}`;
    if (this.absentDistanceRanges.has(rangeKey)) return null;
    const allStarts = [...this.neighbors.keys()].sort();
    const findFrom = (startId: string, endOk: (id: string) => boolean) => {
      const queue = [startId], distances = new Map<string, number>([[startId, 0]]);
      const candidates: { endId: string; shortestJumps: number }[] = [];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i], nextDistance = distances.get(current)! + 1;
        if (nextDistance > maxJumps) continue;
        for (const neighbor of this.neighbors.get(current)!) {
          if (distances.has(neighbor)) continue;
          distances.set(neighbor, nextDistance);
          queue.push(neighbor);
          if (nextDistance >= minJumps && endOk(neighbor)) {
            candidates.push({ endId: neighbor, shortestJumps: nextDistance });
          }
        }
      }
      if (candidates.length) {
        const index = randomInt(candidates.length);
        if (!Number.isSafeInteger(index) || index < 0 || index >= candidates.length) throw new Error('CSLINK_PATH_INVALID_RANDOM');
        return { startId, ...candidates[index], dataVersion: this.dataVersion };
      }
      return null;
    };
    // A caller filter (e.g. portrait + still active) is strict once it has enough starts: filtered-out
    // players must never surface as endpoints. Without a usable filter, prefer numeric identities.
    // Every identity remains usable as an intermediate teammate, including old scoped identities.
    const numeric = (id: string) => id.startsWith('hltv:');
    const passes: { starts: string[]; endOk: (id: string) => boolean }[] = [];
    let strict = false;
    if (endpointAllowed) {
      const allowedStarts = allStarts.filter(endpointAllowed);
      if (allowedStarts.length >= 2) { passes.push({ starts: allowedStarts, endOk: endpointAllowed }); strict = true; }
    }
    if (!strict) {
      const numericStarts = allStarts.filter(numeric);
      if (numericStarts.length >= 2) passes.push({ starts: numericStarts, endOk: numeric });
      passes.push({ starts: allStarts, endOk: () => true });
    }
    for (const { starts, endOk } of passes) {
      const randomAttempts = Math.min(maxSources, starts.length);
      for (let attempt = 0; attempt < randomAttempts; attempt++) {
        const index = randomInt(starts.length);
        if (!Number.isSafeInteger(index) || index < 0 || index >= starts.length) throw new Error('CSLINK_PATH_INVALID_RANDOM');
        const selected = findFrom(starts.splice(index, 1)[0], endOk);
        if (selected) return selected;
      }
      for (const startId of starts) {
        const selected = findFrom(startId, endOk);
        if (selected) return selected;
      }
    }
    this.absentDistanceRanges.add(rangeKey);
    return null;
  }

  /** Call with the server's room start/deadline and server receipt timestamp, never client clock values. */
  finish(round: CsLinkPathRound, routeIds: readonly string[], serverReceivedAtMs: number): CsLinkPathResult {
    if (round.dataVersion !== this.dataVersion) return { valid: false, reason: 'version_changed' };
    if (!round.roundId) return { valid: false, reason: 'wrong_endpoints' };
    if (!validTimestamp(round.serverStartedAtMs) || !validTimestamp(round.serverDeadlineAtMs) ||
        !validTimestamp(serverReceivedAtMs) || round.serverDeadlineAtMs < round.serverStartedAtMs ||
        serverReceivedAtMs < round.serverStartedAtMs) return { valid: false, reason: 'invalid_time' };
    if (serverReceivedAtMs > round.serverDeadlineAtMs) return { valid: false, reason: 'after_deadline' };
    if (!Array.isArray(routeIds) || routeIds.length < 2 ||
        routeIds[0] !== round.startId || routeIds[routeIds.length - 1] !== round.endId ||
        round.startId === round.endId) return { valid: false, reason: 'wrong_endpoints' };
    if (!Number.isSafeInteger(round.maxJumps) || round.maxJumps < 1 ||
        routeIds.length - 1 > round.maxJumps) return { valid: false, reason: 'too_many_jumps' };
    if (new Set(routeIds).size !== routeIds.length) return { valid: false, reason: 'repeated_player' };
    const hops: CsLinkPathHop[] = [];
    for (let i = 1; i < routeIds.length; i++) {
      const fromId = routeIds[i - 1], toId = routeIds[i];
      if (typeof fromId !== 'string' || typeof toId !== 'string' ||
          !this.neighbors.has(fromId) || !this.neighbors.has(toId)) {
        return { valid: false, reason: 'unknown_player' };
      }
      const evidence = this.links.get(edgeKey(fromId, toId));
      if (!evidence) return { valid: false, reason: 'unverified_jump' };
      hops.push({ fromId, toId, evidence: { ...evidence } });
    }
    return { valid: true, finish: {
      roundId: round.roundId, dataVersion: this.dataVersion,
      startId: round.startId, endId: round.endId,
      routeIds: [...routeIds], jumps: routeIds.length - 1,
      serverCompletedAtMs: serverReceivedAtMs, elapsedMs: serverReceivedAtMs - round.serverStartedAtMs, hops,
    } };
  }
}

/** Fewer jumps wins, then earlier server completion; identical scores remain a draw. Negative means A wins. */
export function compareCsLinkPathFinishes(a: CsLinkPathFinish, b: CsLinkPathFinish): number {
  if (a.dataVersion !== b.dataVersion) throw new Error('CSLINK_PATH_VERSION_MISMATCH');
  if (a.roundId !== b.roundId || a.startId !== b.startId || a.endId !== b.endId) {
    throw new Error('CSLINK_PATH_ROUND_MISMATCH');
  }
  if (a.jumps !== b.jumps) return Math.sign(a.jumps - b.jumps);
  return Math.sign(a.elapsedMs - b.elapsedMs);
}

/** A shorter route may improve the score before the deadline; its own completion time is retained. */
export function bestCsLinkPathFinish(finishes: readonly CsLinkPathFinish[]): CsLinkPathFinish | null {
  let best: CsLinkPathFinish | null = null;
  for (const finish of finishes) {
    if (!best || compareCsLinkPathFinishes(finish, best) < 0) best = finish;
  }
  return best;
}

export interface CsLinkPathParticipant {
  playerKey: string;
  finishes: readonly CsLinkPathFinish[];
}

export interface CsLinkPathRoundSettlement {
  winnerKey: string | null;
  reason: 'both_incomplete' | 'one_completed' | 'fewer_jumps' | 'faster_time' | 'exact_tie';
  participants: [
    { playerKey: string; bestFinish: CsLinkPathFinish | null },
    { playerKey: string; bestFinish: CsLinkPathFinish | null },
  ];
}

/** Settle exactly two competitors after the round closes, using only server-validated finishes. */
export function settleCsLinkPathRound(
  round: Pick<CsLinkPathRound, 'roundId' | 'dataVersion' | 'startId' | 'endId'>,
  participants: readonly [CsLinkPathParticipant, CsLinkPathParticipant],
): CsLinkPathRoundSettlement {
  if (!round.roundId || !round.dataVersion || !round.startId || !round.endId ||
      round.startId === round.endId || !participants[0].playerKey || !participants[1].playerKey ||
      participants[0].playerKey === participants[1].playerKey) {
    throw new Error('CSLINK_PATH_INVALID_SETTLEMENT');
  }
  const evaluated = participants.map(participant => {
    for (const finish of participant.finishes) {
      if (finish.dataVersion !== round.dataVersion) throw new Error('CSLINK_PATH_VERSION_MISMATCH');
      if (finish.roundId !== round.roundId || finish.startId !== round.startId ||
          finish.endId !== round.endId) throw new Error('CSLINK_PATH_ROUND_MISMATCH');
    }
    return { playerKey: participant.playerKey, bestFinish: bestCsLinkPathFinish(participant.finishes) };
  }) as CsLinkPathRoundSettlement['participants'];
  const [a, b] = evaluated;
  if (!a.bestFinish && !b.bestFinish) {
    return { winnerKey: null, reason: 'both_incomplete', participants: evaluated };
  }
  if (!a.bestFinish || !b.bestFinish) {
    return { winnerKey: a.bestFinish ? a.playerKey : b.playerKey, reason: 'one_completed', participants: evaluated };
  }
  const comparison = compareCsLinkPathFinishes(a.bestFinish, b.bestFinish);
  if (comparison === 0) return { winnerKey: null, reason: 'exact_tie', participants: evaluated };
  const reason = a.bestFinish.jumps !== b.bestFinish.jumps
    ? 'fewer_jumps' : 'faster_time';
  return { winnerKey: comparison < 0 ? a.playerKey : b.playerKey, reason, participants: evaluated };
}
