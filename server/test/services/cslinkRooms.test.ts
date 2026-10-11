import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsLinkRooms, CsLinkRoomView } from '../../src/services/cslinkRooms';
import { id, longRoute, roomFixture, shortRoute } from '../fixtures/cslinkRooms';

const identity = (key: string) => ({ key, name: key, userId: null });
let rooms: CsLinkRooms;
let initial: number;
let sequence = 0;
const changed = vi.fn();
function lobby(maxPlayers = 2) {
  rooms.connect(identity('a'), 'a1'); rooms.connect(identity('b'), 'b1');
  const room = rooms.create(identity('a'), 60, maxPlayers).room!;
  rooms.join(identity('b'), room.id);
  return room.id;
}
function playing(maxPlayers = 2) {
  const roomId = lobby(maxPlayers);
  rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
  return rooms.start('a', roomId).room!;
}
/** Three seats where c never finishes, so the round stays open until the deadline. */
function playingWithIdle() {
  const roomId = lobby(3);
  rooms.connect(identity('c'), 'c1'); rooms.join(identity('c'), roomId);
  for (const key of ['a', 'b', 'c']) rooms.ready(key, roomId, true);
  return rooms.start('a', roomId).room!;
}
function submit(key: string, room: CsLinkRoomView, routeIds = shortRoute, eventId = `event-${++sequence}`) {
  return rooms.submit(key, { roomId: room.id, roundId: room.round!.roundId,
    dataVersion: room.round!.dataVersion, routeIds, eventId }, Date.now());
}

describe('CS Link local room authority', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000); initial = Date.now();
    changed.mockClear(); rooms = new CsLinkRooms(roomFixture(), changed);
  });
  afterEach(() => { rooms.stop(); vi.useRealTimers(); });

  it('requires ready connected peers and host start, and never exposes the sampled solution', () => {
    const roomId = lobby();
    expect(rooms.start('b', roomId).code).toBe('HOST_ONLY');
    expect(rooms.start('a', roomId).code).toBe('NOT_READY');
    rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
    const room = rooms.start('a', roomId).room!;
    expect(room.round).toMatchObject({ start: { nickname: 'NiKo' }, serverStartedAtMs: initial,
      serverDeadlineAtMs: initial + 60_000, maxJumps: 16 });
    expect(room.round).not.toHaveProperty('shortestJumps');
    expect(room.round).not.toHaveProperty('routeIds');
    expect(rooms.join(identity('c'), roomId).code).toBe('ROOM_NOT_JOINABLE');
    expect(rooms.create(identity('a')).code).toBe('ALREADY_IN_ROOM');
  });

  it('takes fewer jumps before time, allows improvements, and keeps opposing routes private until deadline', () => {
    const room = playingWithIdle();
    vi.advanceTimersByTime(1000);
    expect(submit('a', room, longRoute).improved).toBe(true);
    vi.advanceTimersByTime(1000); submit('b', room);
    const opponent = rooms.sync('b').room!;
    expect(opponent.players.find(player => player.key === 'a')!.best).toEqual({ jumps: 4, elapsedMs: null });
    expect(opponent.players.find(player => player.key === 'b')!.best).toEqual({ jumps: 3, elapsedMs: 2000 });
    expect(opponent.result).toBeNull();
    expect(JSON.stringify(opponent)).not.toContain('hltv:5');
    vi.advanceTimersByTime(1000);
    expect(submit('a', room).improved).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(submit('a', room).improved).toBe(false);
    expect(rooms.sync('a').room!.myBest!.elapsedMs).toBe(3000);
    vi.advanceTimersByTime(56_001);
    const finished = rooms.sync('a').room!;
    expect(finished.status).toBe('finished');
    expect(finished.result).toMatchObject({ winnerKeys: ['b'], reason: 'faster_time' });
    expect(finished.result!.rankings[0].best!.hops).toHaveLength(3);
    expect(finished.result!.rankings[0].best!.hops[0].evidence.sourceUrl).toContain('/102/fixture');
    expect(finished.players.find(player => player.key === 'a')!.best).toEqual({ jumps: 3, elapsedMs: 3000 });
  });

  it('settles as soon as every remaining player has connected', () => {
    const room = playing();
    vi.advanceTimersByTime(1000); submit('a', room, longRoute);
    expect(rooms.sync('a').room!.status).toBe('playing');
    vi.advanceTimersByTime(1000); submit('b', room);
    const done = rooms.sync('a').room!;
    expect(done.status).toBe('finished');
    expect(done.result).toMatchObject({ winnerKeys: ['b'], reason: 'fewer_jumps' });
    expect(submit('a', room).code).toBe('ROUND_EXPIRED');
  });

  it('settles fewer-jump wins, one finisher, and all-incomplete ties', () => {
    let room = playing();
    submit('a', room, longRoute); vi.advanceTimersByTime(500); submit('b', room);
    vi.advanceTimersByTime(59_501);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: ['b'], reason: 'fewer_jumps' });
    rooms.rematch('a', room.id); rooms.ready('a', room.id, true); rooms.ready('b', room.id, true);
    room = rooms.start('a', room.id).room!; submit('a', room);
    vi.advanceTimersByTime(60_001);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: ['a'], reason: 'one_completed' });
    rooms.rematch('a', room.id); rooms.ready('a', room.id, true); rooms.ready('b', room.id, true);
    rooms.start('a', room.id); vi.advanceTimersByTime(60_001);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: [], reason: 'all_incomplete' });
  });

  it('accepts both submissions at the deadline after a sync and preserves exact ties', () => {
    const room = playing();
    vi.advanceTimersByTime(60_000);
    expect(rooms.sync('a').room!.status).toBe('playing');
    expect(submit('a', room).code).toBeUndefined();
    expect(submit('b', room).code).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: ['a', 'b'], reason: 'exact_tie' });
    expect(submit('a', room).code).toBe('ROUND_EXPIRED');
  });

  it('rejects invalid paths, mismatched versions/rounds and altered event retries without score changes', () => {
    const room = playing(), eventId = 'a-retry-token';
    const first = submit('a', room, shortRoute, eventId);
    vi.advanceTimersByTime(1000);
    const retry = submit('a', room, shortRoute, eventId);
    expect(retry.improved).toBe(first.improved);
    expect(retry.room!.myBest!.elapsedMs).toBe(0);
    expect(submit('a', room, longRoute, eventId).code).toBe('EVENT_ID_CONFLICT');
    expect(submit('a', room, [id(1), id(4)])).toMatchObject({ code: 'INVALID_PATH', reason: 'unverified_jump' });
    const input = { roomId: room.id, roundId: room.round!.roundId, dataVersion: 'wrong', routeIds: shortRoute, eventId: 'wrong-version' };
    expect(rooms.submit('a', input, Date.now()).code).toBe('VERSION_MISMATCH');
    expect(rooms.submit('a', { ...input, roundId: 'other' }, Date.now()).code).toBe('ROUND_MISMATCH');
    expect(submit('outsider', room).code).toBe('NOT_IN_ROOM');
  });

  it('restores scores by authenticated identity across disconnects and multiple tabs', () => {
    const room = playing(); vi.advanceTimersByTime(1234); submit('a', room);
    rooms.connect(identity('a'), 'a2'); rooms.disconnect('a', 'a1');
    expect(rooms.sync('b').room!.players[0].connected).toBe(true);
    rooms.disconnect('a', 'a2');
    expect(rooms.sync('b').room!.players[0].connected).toBe(false);
    rooms.connect(identity('a'), 'a3');
    expect(rooms.sync('a').room!.myBest).toMatchObject({ elapsedMs: 1234, jumps: 3 });
    expect(rooms.sync('a').room!.round!.roundId).toBe(room.round!.roundId);
  });

  it('prevents active leavers rejoining or resetting scores and transfers ownership', () => {
    const room = playing(); submit('a', room);
    expect(rooms.leave('a', room.id).room).toBeNull();
    expect(rooms.join(identity('a'), room.id).code).toBe('LEFT_ROUND');
    expect(rooms.create(identity('a')).code).toBe('LEFT_ROUND');
    expect(submit('a', room).code).toBe('LEFT_ROUND');
    expect(rooms.sync('b').room!.hostKey).toBe('b');
    expect(rooms.join(identity('c'), room.id).code).toBe('ROOM_NOT_JOINABLE');
    submit('b', room); vi.advanceTimersByTime(60_001);
    expect(rooms.sync('b').room!.result!.winnerKeys).toEqual(['b']);
    expect(rooms.rematch('b', room.id).room!.players.map(player => player.key)).toEqual(['b']);
    expect(rooms.join(identity('a'), room.id).code).toBeUndefined();
  });

  it('keeps a settled winner after they leave and clears the snapshot only for a new round', () => {
    const room = playing(); submit('a', room); vi.advanceTimersByTime(2000); submit('b', room);
    vi.advanceTimersByTime(58_001);
    const result = rooms.sync('b').room!.result;
    rooms.leave('a', room.id);
    expect(rooms.sync('b').room!.result).toEqual(result);
    expect(rooms.sync('b').room!.result!.winnerKeys).toEqual(['a']);
    expect(rooms.rematch('b', room.id).room).toMatchObject({ status: 'lobby', round: null, result: null, myBest: null });
  });

  it('supports eight players, bounded capacity and tied ranks', () => {
    const roomId = lobby(8);
    for (const key of ['c', 'd', 'e', 'f', 'g', 'h']) {
      rooms.connect(identity(key), key); expect(rooms.join(identity(key), roomId).code).toBeUndefined();
    }
    expect(rooms.join(identity('i'), roomId).code).toBe('ROOM_FULL');
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) rooms.ready(key, roomId, true);
    const room = rooms.start('a', roomId).room!;
    submit('a', room); submit('b', room); vi.advanceTimersByTime(100); submit('c', room);
    vi.advanceTimersByTime(59_901);
    const result = rooms.sync('a').room!.result!;
    expect(result.winnerKeys).toEqual(['a', 'b']);
    expect(result.rankings.slice(0, 4).map(row => row.rank)).toEqual([1, 1, 3, null]);
  });

  it('expires idle rooms without deleting active rounds and stops every timer', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { roomTtlMs: 1000, maxRooms: 1 });
    const room = playing();
    expect(rooms.create(identity('c')).code).toBe('ROOM_LIMIT');
    vi.advanceTimersByTime(30_000);
    expect(rooms.sync('a').room!.status).toBe('playing');
    vi.advanceTimersByTime(30_001); vi.advanceTimersByTime(29_999);
    expect(rooms.sync('a').room).toBeNull();
    rooms.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
