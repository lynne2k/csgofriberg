import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CsLinkDaily, resetCsLinkDailyMemory } from '../../src/services/cslinkDaily';
import { CsLinkRooms } from '../../src/services/cslinkRooms';
import { liveObject, readCsLinkSelection } from '../../src/services/cslinkLiveData';
import { startCsLinkControl } from '../../src/services/cslinkControl';
import { loadCsLinkNickLexicon, moderateCsLinkNickname } from '../../src/services/cslinkNickModeration';
import { roomFixture, shortRoute } from '../fixtures/cslinkRooms';

const identity = (key: string) => ({ key, name: key, userId: null });
const dirs: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-')); dirs.push(dir); return dir; };
afterEach(() => { resetCsLinkDailyMemory(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('CS Link live data and maintenance', () => {
  it('pins graph, player metadata and filters for an existing room while new rooms see the update', () => {
    let current = roomFixture(), now = 100_000;
    const rooms = new CsLinkRooms(liveObject(() => current), () => {}, { now: () => now });
    try {
      for (const key of ['a', 'b']) rooms.connect(identity(key), key);
      const roomId = rooms.create(identity('a'), 40, 2, 1).room!.id;
      rooms.join(identity('b'), roomId);
      rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
      const room = rooms.start('a', roomId).room!;
      current = roomFixture('b'.repeat(20));
      const originalGet = current.getPathPlayer;
      current.getPathPlayer = id => { const p = originalGet(id); return p ? { ...p, nickname: 'NEW' } : null; };
      now += 1000;
      const reply = rooms.submit('a', { roomId, roundId: room.round!.roundId,
        dataVersion: room.round!.dataVersion, routeIds: shortRoute, eventId: 'old-version-finish' }, now);
      expect(reply.improved).toBe(true);
      expect(reply.room!.myBest!.route[0].nickname).toBe('NiKo');
      expect(reply.room!.round!.dataVersion).not.toBe(current.pathGraph().dataVersion);
      const fresh = rooms.create(identity('c')).room!;
      rooms.connect(identity('c'), 'c'); rooms.connect(identity('d'), 'd');
      rooms.join(identity('d'), fresh.id);
      rooms.ready('c', fresh.id, true); rooms.ready('d', fresh.id, true);
      expect(rooms.start('c', fresh.id).room!.round).toMatchObject({ dataVersion: 'b'.repeat(20), start: { nickname: 'NEW' } });
    } finally { rooms.stop(); }
  });

  it('keeps today and its scores across a graph update and daily-service reconstruction', async () => {
    let current = roomFixture(), now = Date.UTC(2026, 9, 27, 4);
    const file = path.join(temp(), 'daily.json');
    const store = liveObject(() => current);
    const make = () => new CsLinkDaily(store, undefined, () => now, undefined, file);
    const daily = make(), before = daily.today()!;
    await daily.start('g:test', 'Tester'); await daily.begin('g:test', 'Tester'); now += 1000;
    await daily.submit('g:test', 'Tester', { date: before.date, dataVersion: before.dataVersion, routeIds: shortRoute });
    current = roomFixture('b'.repeat(20));
    // If sampling happens again today, the endpoints would change.
    current.pathGraph().sampleDistantPair = () => { throw new Error('must not resample'); };
    daily.validateSnapshot(current);
    const after = daily.today()!;
    expect(after.bucket).toBe(before.bucket);
    expect(after.start.id).toBe(before.start.id);
    expect(after.dataVersion).toBe('b'.repeat(20));
    const recreated = make();
    expect(recreated.today()).toEqual(after);
    expect(await recreated.leaderboard('g:test', 10)).toMatchObject({ finished: 1, me: { rank: 1, elapsedMs: 1000 } });
    expect(await daily.submit('g:test', 'Tester', { date: before.date, dataVersion: before.dataVersion, routeIds: shortRoute }))
      .toEqual({ code: 'VERSION_MISMATCH' });
    expect(() => daily.validateSnapshot({ ...current, getPathPlayer: () => null })).toThrow('CSLINK_RELOAD_BREAKS_DAILY_QUESTION');
  });

  it('refuses new matches when draining, allows current submissions, and reports when safe', () => {
    const rooms = new CsLinkRooms(roomFixture(), () => {}, { now: () => 100_000 });
    try {
      for (const k of ['a', 'b']) rooms.connect(identity(k), k);
      const roomId = rooms.create(identity('a'), 40, 2, 1).room!.id;
      rooms.join(identity('b'), roomId);
      rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
      const round = rooms.start('a', roomId).room!.round!;
      rooms.queue(identity('waiting'));
      expect(rooms.drain(true)).toMatchObject({ queued: 0, activeMatches: 1, safeToRestart: false });
      expect(rooms.create(identity('c')).code).toBe('SERVER_MAINTENANCE');
      expect(rooms.queue(identity('c')).code).toBe('SERVER_MAINTENANCE');
      rooms.submit('a', { roomId, roundId: round.roundId, dataVersion: round.dataVersion,
        routeIds: shortRoute, eventId: 'submit-while-draining' }, 101_000);
      rooms.giveUp('b', roomId, round.roundId);
      expect(rooms.status()).toMatchObject({ activeMatches: 0, safeToRestart: true });
      rooms.drain(false);
      expect(rooms.create(identity('c')).code).toBeUndefined();
    } finally { rooms.stop(); }
  });

  it('rejects incomplete selection files rather than quietly expanding the question pool', () => {
    const dir = temp(), active = path.join(dir, 'active.json'), popularity = path.join(dir, 'popularity.json');
    fs.writeFileSync(active, JSON.stringify({ ids: [] })); fs.writeFileSync(popularity, JSON.stringify({}));
    expect(() => readCsLinkSelection(roomFixture(), { active, popularity })).toThrow('CSLINK_INVALID_SELECTION_FILES');
  });

  it('retains nickname moderation if a replacement file is missing', () => {
    expect(loadCsLinkNickLexicon()).toBe(true);
    expect(loadCsLinkNickLexicon(path.join(temp(), 'missing.json'))).toBe(false);
    expect(moderateCsLinkNickname('炸弹').ok).toBe(false);
  });

  it('serves maintenance on an owner-only local socket and refuses duplicate listeners', async () => {
    const socketPath = path.join(temp(), 'control.sock');
    const stop = await startCsLinkControl(socketPath, command => {
      if (command === 'status') return { activeMatches: 2 };
      throw new Error('UNKNOWN_COMMAND');
    });
    const request = (command: string) => new Promise<any>((resolve, reject) => {
      const socket = net.connect(socketPath, () => socket.write(command + '\n')); let data = '';
      socket.on('data', chunk => { data += chunk; }); socket.on('error', reject);
      socket.on('end', () => resolve(JSON.parse(data)));
    });
    try {
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(await request('status')).toEqual({ ok: true, result: { activeMatches: 2 } });
      expect(await request('oops')).toEqual({ ok: false, error: 'UNKNOWN_COMMAND' });
      await expect(startCsLinkControl(socketPath, () => {})).rejects.toThrow('CSLINK_CONTROL_ALREADY_RUNNING');
    } finally { await stop(); }
  });
});
