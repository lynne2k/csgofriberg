#!/usr/bin/env node
// End-to-end check against the running local server, using its normal guest session and PoW routes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { io } = require('socket.io-client');
const base = process.env.CSLINK_SMOKE_BASE ?? 'http://127.0.0.1:3000';
const userAgent = 'CSLinkDuelSmoke/1.0';
const domain = Buffer.from('csgofriberg-pow-v1\0', 'ascii');
const sockets = new Set();

function validDigest(challenge, nonce, difficulty) {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const first = crypto.createHash('sha256').update(domain).update(challenge).update(nonceBytes).digest();
  const mixed = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) mixed[i] = first[(i + 11) & 31] ^ first[i] ^ ((i * 29 + 0x5d) & 255);
  const digest = crypto.createHash('sha256').update(domain).update(mixed).digest();
  const bytes = Math.floor(difficulty / 8);
  for (let i = 0; i < bytes; i++) if (digest[i] !== 0) return false;
  const bits = difficulty & 7;
  return !bits || (digest[bytes] & (255 << (8 - bits))) === 0;
}

async function request(path, cookie = '', body) {
  const response = await fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'User-Agent': userAgent, Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return { data: await response.json(), cookies: response.headers.getSetCookie().map(row => row.split(';')[0]) };
}

async function guests() {
  const { data: challenge } = await request('/pow/challenge', '', {});
  assert.equal(challenge.algorithm, 'csgofriberg-pow-v1');
  assert(challenge.difficulty >= 16 && challenge.difficulty <= 24);
  const bytes = Buffer.from(challenge.challenge, 'base64url');
  let nonce = null;
  for (let candidate = 0n; candidate < 10_000_000n; candidate++) {
    if (validDigest(bytes, candidate, challenge.difficulty)) { nonce = candidate.toString(); break; }
  }
  assert.notEqual(nonce, null, 'PoW bounded search exhausted');
  const proof = await request('/pow/verify', '', { id: challenge.id, nonce });
  const powCookie = proof.cookies.join('; ');
  const first = await request('/auth/session', powCookie, {});
  const second = await request('/auth/session', powCookie, {});
  const third = await request('/auth/session', powCookie, {});
  return [first, second, third].map(row => [powCookie, ...row.cookies].join('; '));
}

async function connect(cookie) {
  const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false,
    extraHeaders: { Cookie: cookie, 'User-Agent': userAgent } });
  sockets.add(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
  return socket;
}

function emit(socket, event, payload = {}) {
  return new Promise((resolve, reject) => socket.timeout(10000).emit(event, payload,
    (error, reply) => error ? reject(error) : resolve(reply)));
}

function success(reply) { assert(!reply.code, JSON.stringify(reply)); return reply; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function waitForFinished(socket, durationMs) {
  return new Promise((resolve, reject) => {
    const handler = state => {
      if (state.room?.status !== 'finished') return;
      clearTimeout(timer); socket.off('cslink:state', handler); resolve(state);
    };
    const timer = setTimeout(() => {
      socket.off('cslink:state', handler); reject(new Error('Settlement not broadcast at deadline'));
    }, durationMs + 10000);
    socket.on('cslink:state', handler);
  });
}

try {
  // A third player stays idle so the round runs to its deadline instead of settling once A and B finish.
  const [cookieA, cookieB, cookieC] = await guests();
  let a = await connect(cookieA);
  const b = await connect(cookieB);
  const c = await connect(cookieC);
  // targetScore 1 keeps the smoke to a single settled round.
  const created = success(await emit(a, 'cslink:create', { durationSeconds: 20, maxPlayers: 3, targetScore: 1 }));
  const roomId = created.room.id;
  const joined = success(await emit(b, 'cslink:join', { roomId }));
  success(await emit(c, 'cslink:join', { roomId }));
  assert.notEqual(created.meKey, joined.meKey, 'Players must have independent identities');
  assert.equal((await emit(b, 'cslink:start', { roomId })).code, 'HOST_ONLY');
  success(await emit(a, 'cslink:ready', { roomId, ready: true }));
  success(await emit(b, 'cslink:ready', { roomId, ready: true }));
  success(await emit(c, 'cslink:ready', { roomId, ready: true }));
  const started = success(await emit(a, 'cslink:start', { roomId }));
  const roundId = started.room.round.roundId;
  // Duel pages report arrival; once everyone is in, the clock is pulled forward to a short countdown.
  success(await emit(a, 'cslink:arrive', { roomId, roundId }));
  success(await emit(b, 'cslink:arrive', { roomId, roundId }));
  success(await emit(c, 'cslink:arrive', { roomId, roundId }));
  const armed = success(await emit(a, 'cslink:sync'));
  const round = armed.room.round;
  assert(round.serverStartedAtMs < started.room.round.serverStartedAtMs, 'Arrival must pull the clock forward');
  const other = success(await emit(b, 'cslink:sync'));
  assert.deepEqual(other.room.round, round, 'Players must receive identical endpoints/version/clocks');
  await delay(Math.max(0, round.serverStartedAtMs - armed.serverNowMs) + 200);
  assert.equal(round.serverDeadlineAtMs - round.serverStartedAtMs, 20000);
  assert.equal(other.room.result, null);
  assert.equal(other.room.myBest, null);
  assert(!JSON.stringify(round).includes('shortestJumps'), 'Question must not publish a solution');
  const ended = waitForFinished(b, 20000);
  const query = new URLSearchParams({ playerA: round.start.id, playerB: round.end.id, version: round.dataVersion });
  const { data: path } = await request(`/cslink/play/path?${query}`, cookieA);
  assert.equal(path.status, 'connected');
  assert(path.jumps >= 3 && path.jumps <= 6);
  const submission = { roomId, roundId: round.roundId, dataVersion: round.dataVersion,
    routeIds: path.players.map(player => player.id), eventId: crypto.randomUUID() };
  const invalid = await emit(a, 'cslink:submit', { ...submission, eventId: crypto.randomUUID(),
    routeIds: [round.start.id, round.end.id] });
  assert.equal(invalid.code, 'INVALID_PATH');
  assert.equal(invalid.room.myBest, null);
  const detour = path.legs[0].proof.lineup.find(player => !submission.routeIds.includes(player.id));
  assert(detour, 'A real five-player lineup should provide a one-hop detour');
  const longer = success(await emit(a, 'cslink:submit', { ...submission, eventId: crypto.randomUUID(),
    routeIds: [submission.routeIds[0], detour.id, ...submission.routeIds.slice(1)] }));
  assert.equal(longer.room.myBest.jumps, path.jumps + 1);
  await delay(80);
  const winner = success(await emit(b, 'cslink:submit', submission));
  assert.equal(winner.improved, true);
  assert.equal(winner.room.myBest.jumps, path.jumps);
  assert(winner.room.myBest.elapsedMs > longer.room.myBest.elapsedMs);
  assert(winner.room.myBest.hops.every(hop => /^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\//.test(hop.evidence.sourceUrl)));
  await delay(80);
  const original = success(await emit(a, 'cslink:submit', submission));
  assert(original.room.myBest.elapsedMs > winner.room.myBest.elapsedMs);
  const retry = success(await emit(a, 'cslink:submit', submission));
  assert.deepEqual(retry.room.myBest, original.room.myBest, 'Retry must not rewrite completion time');
  assert.equal((await emit(a, 'cslink:submit', { ...submission, routeIds: [round.start.id, round.end.id] })).code,
    'EVENT_ID_CONFLICT');
  assert.equal((await emit(a, 'cslink:submit', { ...submission, eventId: crypto.randomUUID(), dataVersion: 'stale' })).code,
    'VERSION_MISMATCH');
  const privacy = success(await emit(a, 'cslink:sync'));
  assert(privacy.room.players.every(player => !('route' in player) && !('routeIds' in player)));
  assert(privacy.room.players.filter(player => player.best).every(player => Object.keys(player.best).sort().join(',') === 'elapsedMs,jumps'));
  a.disconnect();
  await delay(100);
  a = await connect(cookieA);
  const restored = success(await emit(a, 'cslink:sync'));
  assert.equal(restored.meKey, created.meKey);
  assert.equal(restored.room.round.serverDeadlineAtMs, round.serverDeadlineAtMs);
  assert.deepEqual(restored.room.myBest, original.room.myBest, 'Reconnect must restore the confirmed best path');
  console.log(JSON.stringify({ phase: 'waiting_for_deadline', roomId, roundId: round.roundId,
    start: round.start.nickname, end: round.end.nickname, jumps: path.jumps,
    reconnect: 'passed', privateOpponentRoutes: 'passed', idempotency: 'passed' }));
  const finalB = await ended;
  const finalA = success(await emit(a, 'cslink:sync'));
  assert.equal(finalA.room.status, 'finished');
  assert.deepEqual(finalA.room.result, finalB.room.result);
  assert.deepEqual(finalA.room.result.winnerKeys, [joined.meKey]);
  assert.equal(finalA.room.result.reason, 'faster_time');
  assert(finalA.room.result.rankings.filter(row => row.best).every(row => row.best.hops.length === path.jumps));
  assert.equal((await emit(a, 'cslink:submit', { ...submission, eventId: crypto.randomUUID() })).code, 'ROUND_EXPIRED');
  const replay = success(await emit(a, 'cslink:rematch', { roomId }));
  assert.equal(replay.room.status, 'lobby');
  assert.equal(replay.room.round, null);
  assert.equal(replay.room.myBest, null);
  assert(replay.room.players.every(player => !player.ready && !player.best));
  success(await emit(b, 'cslink:leave', { roomId }));
  success(await emit(c, 'cslink:leave', { roomId }));
  success(await emit(a, 'cslink:leave', { roomId }));
  const report = { checkedAt: new Date().toISOString(), roomId, dataVersion: round.dataVersion,
    endpoints: [round.start.nickname, round.end.nickname], jumps: path.jumps,
    sourceUrls: original.room.myBest.hops.map(hop => hop.evidence.sourceUrl),
    checks: ['guest-auth', 'same-question-and-clock', 'host-only-start', 'invalid-route-rejection',
      'fewer-jumps-then-time-rule', 'same-jumps-earlier-time-wins', 'idempotent-submit', 'conflicting-event-rejected',
      'version-mismatch-rejected', 'opponent-route-hidden', 'reconnect-restores-best',
      'deadline-broadcast', 'matching-settlement', 'per-hop-hltv-links', 'expired-submit-rejected', 'rematch', 'leave'],
    result: finalA.room.result };
  fs.writeFileSync(new URL('../.local-data/cslink/duel-smoke.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: 'passed', checks: report.checks.length, roomId, jumps: path.jumps,
    result: report.result.reason, report: '.local-data/cslink/duel-smoke.json' }, null, 2));
} finally {
  for (const socket of sockets) socket.disconnect();
}
