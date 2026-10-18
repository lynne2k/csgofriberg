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

  it('lets a player give up, shows it to others, and settles once everyone is done', () => {
    let room = playing();
    expect(rooms.giveUp('b', room.id, room.round!.roundId).code).toBeUndefined();
    const view = rooms.sync('a').room!;
    expect(view.status).toBe('playing');
    expect(view.players.find(p => p.key === 'b')!.gaveUp).toBe(true);
    expect(submit('b', room).code).toBe('GAVE_UP');
    expect(rooms.giveUp('b', room.id, room.round!.roundId).code).toBeUndefined();
    expect(rooms.giveUp('b', room.id, 'other').code).toBe('ROUND_MISMATCH');
    submit('a', room);
    const done = rooms.sync('a').room!;
    expect(done.result).toMatchObject({ winnerKeys: ['a'], reason: 'one_completed' });
    expect(done.result!.rankings.find(row => row.key === 'b')!.gaveUp).toBe(true);

    rooms.rematch('a', room.id); rooms.ready('a', room.id, true); rooms.ready('b', room.id, true);
    room = rooms.start('a', room.id).room!;
    expect(room.players.every(p => !p.gaveUp)).toBe(true);
    rooms.giveUp('a', room.id, room.round!.roundId); rooms.giveUp('b', room.id, room.round!.roundId);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: [], reason: 'all_incomplete' });
    // Nobody connected: the result still publishes a shortest route with per-hop HLTV sources.
    const answer = rooms.sync('a').room!.result!.answer!;
    expect(answer.routeIds[0]).toBe(room.round!.start.id);
    expect(answer.routeIds.at(-1)).toBe(room.round!.end.id);
    expect(answer.jumps).toBe(answer.routeIds.length - 1);
    expect(answer.route.map(p => p.id)).toEqual(answer.routeIds);
    answer.hops.forEach(hop => expect(hop.evidence.sourceUrl).toContain('hltv.org'));
    expect(rooms.giveUp('a', room.id, room.round!.roundId).code).toBe('NOT_PLAYING');
  });

  it('refuses to give up after connecting and keeps waiting for the rest', () => {
    const room = playingWithIdle();
    submit('a', room);
    expect(rooms.giveUp('a', room.id, room.round!.roundId).code).toBe('ALREADY_CONNECTED');
    rooms.giveUp('b', room.id, room.round!.roundId);
    expect(rooms.sync('a').room!.status).toBe('playing');
    rooms.giveUp('c', room.id, room.round!.roundId);
    expect(rooms.sync('a').room!.result).toMatchObject({ winnerKeys: ['a'], reason: 'one_completed' });
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

  it('accumulates round wins, ends the match at the target score and resets on the next match', () => {
    const roomId = lobby();
    expect(rooms.sync('a').room!.difficulty).toBe('normal');
    expect(rooms.setOptions('a', roomId, { difficulty: 'impossible' as any }).code).toBe('VALIDATION_FAILED');
    expect(rooms.setOptions('a', roomId, { difficulty: 'easy' }).room!.difficulty).toBe('easy');
    expect(rooms.setOptions('b', roomId, { difficulty: 'hell' }).code).toBe('HOST_ONLY');
    expect(rooms.setOptions('b', roomId, { targetScore: 2 }).code).toBe('HOST_ONLY');
    expect(rooms.setOptions('a', roomId, { targetScore: 11 }).code).toBe('VALIDATION_FAILED');
    expect(rooms.setOptions('a', roomId, { durationSeconds: 19 }).code).toBe('VALIDATION_FAILED');
    expect(rooms.setOptions('a', roomId, { targetScore: 2, durationSeconds: 30 }).room).toMatchObject({ targetScore: 2, durationSeconds: 30 });
    const round = () => { rooms.ready('a', roomId, true); rooms.ready('b', roomId, true); return rooms.start('a', roomId).room!; };
    let room = round(); submit('a', room); vi.advanceTimersByTime(30_001);
    let view = rooms.sync('a').room!;
    expect(view.players.map(player => player.score)).toEqual([1, 0]);
    expect(view.matchOver).toBe(false);
    expect(rooms.setOptions('a', roomId, { targetScore: 3 }).code).toBe('NOT_LOBBY');
    rooms.rematch('a', roomId);
    expect(rooms.sync('a').room!.players.map(player => player.score)).toEqual([1, 0]);
    room = round(); submit('a', room); vi.advanceTimersByTime(30_001);
    view = rooms.sync('b').room!;
    expect(view.players.map(player => player.score)).toEqual([2, 0]);
    expect(view.matchOver).toBe(true);
    view = rooms.rematch('a', roomId).room!;
    expect(view).toMatchObject({ matchOver: false, status: 'lobby' });
    expect(view.players.map(player => player.score)).toEqual([0, 0]);
  });

  it('starts the next round of an unfinished match by itself, keeping scores, even when nobody connected', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { interRoundMs: 5000 });
    let room = playing();
    expect(room.roundNo).toBe(1);
    rooms.giveUp('b', room.id, room.round!.roundId);
    vi.advanceTimersByTime(60_001);
    let view = rooms.sync('a').room!;
    expect(view).toMatchObject({ status: 'finished', matchOver: false, roundNo: 1 });
    expect(view.result!.winnerKeys).toEqual([]);
    expect(view.nextRoundAtMs).toBeGreaterThan(Date.now());
    expect(rooms.nextRound('b', room.id).code).toBe('HOST_ONLY');
    vi.advanceTimersByTime(5000);
    view = rooms.sync('b').room!;
    expect(view).toMatchObject({ status: 'playing', roundNo: 2, nextRoundAtMs: null, result: null, myBest: null });
    expect(view.round!.roundId).not.toBe(room.round!.roundId);
    room = view; submit('a', room); vi.advanceTimersByTime(60_001);
    expect(rooms.sync('a').room!.players.map(player => player.score)).toEqual([1, 0]);
    view = rooms.nextRound('a', room.id).room!;
    expect(view).toMatchObject({ status: 'playing', roundNo: 3 });
    expect(view.players.map(player => player.score)).toEqual([1, 0]);
  });

  it('stops auto-continuing when nobody touched the round', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { interRoundMs: 5000 });
    const room = playing();
    vi.advanceTimersByTime(70_000);
    expect(rooms.sync('a').room).toMatchObject({ status: 'finished', roundNo: 1, nextRoundAtMs: null });
    expect(rooms.nextRound('a', room.id).room).toMatchObject({ status: 'playing', roundNo: 2 });
  });

  it('does not auto-continue once the match is won or when only one player is left', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { interRoundMs: 5000 });
    const roomId = lobby();
    rooms.setOptions('a', roomId, { targetScore: 1 });
    rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
    let room = rooms.start('a', roomId).room!;
    submit('a', room); vi.advanceTimersByTime(70_000);
    let view = rooms.sync('a').room!;
    expect(view).toMatchObject({ status: 'finished', matchOver: true, nextRoundAtMs: null });
    expect(rooms.nextRound('a', roomId).code).toBe('NOT_FINISHED');
    view = rooms.rematch('a', roomId).room!;
    expect(view).toMatchObject({ roundNo: 0, status: 'lobby' });
    rooms.setOptions('a', roomId, { targetScore: 3 });
    rooms.ready('a', roomId, true); rooms.ready('b', roomId, true);
    room = rooms.start('a', roomId).room!;
    expect(room.roundNo).toBe(1);
    rooms.leave('b', roomId);
    vi.advanceTimersByTime(70_000);
    view = rooms.sync('a').room!;
    expect(view).toMatchObject({ status: 'finished', roundNo: 1, nextRoundAtMs: null });
  });

  it('waits for every player to arrive, then pulls the clock forward and rejects early submissions', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { countdownMs: 3000, arrivalGraceMs: 12_000 });
    const room = playing();
    expect(room.round!.serverStartedAtMs).toBe(initial + 15_000);
    expect(room.waitingKeys).toEqual(['a', 'b']);
    vi.advanceTimersByTime(1000);
    expect(rooms.arrive('a', room.id, room.round!.roundId).room!.waitingKeys).toEqual(['b']);
    expect(submit('a', room).code).toBeDefined();
    vi.advanceTimersByTime(1000);
    const ready = rooms.arrive('b', room.id, room.round!.roundId).room!;
    expect(ready.waitingKeys).toEqual([]);
    expect(ready.round!.serverStartedAtMs).toBe(initial + 5000);
    expect(ready.round!.serverDeadlineAtMs).toBe(initial + 65_000);
    vi.advanceTimersByTime(3000);
    expect(submit('a', room).code).toBeUndefined();
    vi.advanceTimersByTime(60_001);
    expect(rooms.sync('a').room!.status).toBe('finished');
  });

  it('starts anyway at the grace limit when someone never arrives', () => {
    rooms.stop(); rooms = new CsLinkRooms(roomFixture(), changed, { countdownMs: 3000, arrivalGraceMs: 12_000 });
    const room = playing();
    rooms.arrive('a', room.id, room.round!.roundId);
    vi.advanceTimersByTime(15_000);
    expect(submit('a', room).code).toBeUndefined();
    expect(rooms.sync('a').room!.round!.serverStartedAtMs).toBe(initial + 15_000);
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

  it('frees a lobby seat after a disconnect grace period and hands host over', () => {
    const roomId = lobby(2);
    rooms.disconnect('a', 'a1');
    vi.advanceTimersByTime(10_000);
    rooms.connect(identity('a'), 'a2');
    vi.advanceTimersByTime(10_000);
    expect(rooms.sync('b').room!.players.map(p => p.key)).toEqual(['a', 'b']);
    rooms.disconnect('a', 'a2');
    vi.advanceTimersByTime(15_001);
    const view = rooms.sync('b').room!;
    expect(view.players.map(p => p.key)).toEqual(['b']);
    expect(view.hostKey).toBe('b');
    rooms.connect(identity('c'), 'c1');
    expect(rooms.join(identity('c'), roomId).code).toBeUndefined();
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
