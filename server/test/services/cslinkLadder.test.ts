import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsLinkRooms, CsLinkRoomView } from '../../src/services/cslinkRooms';
import { CsLinkLadder, eloExpected } from '../../src/services/cslinkLadder';
import { roomFixture, shortRoute } from '../fixtures/cslinkRooms';

const identity = (key: string) => ({ key, name: key, userId: null });
let rooms: CsLinkRooms;
let ladder: CsLinkLadder;
let sequence = 0;
function submit(key: string, room: CsLinkRoomView) {
  return rooms.submit(key, { roomId: room.id, roundId: room.round!.roundId,
    dataVersion: room.round!.dataVersion, routeIds: shortRoute, eventId: `event-${++sequence}` }, Date.now());
}

describe('CS Link ladder matchmaking', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    ladder = new CsLinkLadder(null);
    rooms = new CsLinkRooms(roomFixture(), () => undefined, { ladder, interRoundMs: 1000 });
    rooms.connect(identity('a'), 'a1'); rooms.connect(identity('b'), 'b1');
  });
  afterEach(() => { rooms.stop(); vi.useRealTimers(); });

  it('pairs the first two queued players into a started ranked room with fixed options', () => {
    const waiting = rooms.queue(identity('a'));
    expect(waiting.room).toBeNull();
    expect(waiting.queue).toMatchObject({ waiting: 1 });
    const paired = rooms.queue(identity('b')).room!;
    expect(paired).toMatchObject({ ranked: true, status: 'playing', durationSeconds: 20, targetScore: 3, difficulty: 'normal' });
    expect(rooms.sync('a').room!.id).toBe(paired.id);
    expect(rooms.sync('a').queue).toBeUndefined();
    expect(rooms.setOptions('a', paired.id, { targetScore: 1 }).code).toBe('RANKED_FIXED');
  });

  it('drops disconnected or cancelled players from the queue', () => {
    rooms.queue(identity('a')); rooms.unqueue('a');
    expect(rooms.queue(identity('b')).room).toBeNull();
    rooms.disconnect('b', 'b1');
    rooms.connect(identity('c'), 'c1');
    expect(rooms.queue(identity('c')).room).toBeNull();
  });

  it('settles Elo once when a player reaches the target score', () => {
    rooms.queue(identity('a'));
    let room = rooms.queue(identity('b')).room!;
    for (let round = 0; round < 3; round++) {
      submit('a', room); rooms.giveUp('b', room.id, room.round!.roundId);
      vi.advanceTimersByTime(1001);
      room = rooms.sync('a').room!;
    }
    expect(room.matchOver).toBe(true);
    expect(room.ladderDelta).toEqual({ a: 16, b: -16 });
    expect(ladder.rating('a')).toBe(1016);
    expect(ladder.top(1)[0]).toMatchObject({ name: 'a', rating: 1016, games: 1 });
    // 结算后再匹配会自动离开旧房
    rooms.connect(identity('c'), 'c1'); rooms.queue(identity('c'));
    expect(rooms.queue(identity('a')).room!.ranked).toBe(true);
    expect(ladder.rating('a')).toBe(1016);
  });

  it('counts leaving a ranked match as a forfeit', () => {
    rooms.queue(identity('a'));
    const room = rooms.queue(identity('b')).room!;
    rooms.leave('b', room.id);
    const view = rooms.sync('a').room!;
    expect(view.matchOver).toBe(true);
    expect(view.ladderDelta).toEqual({ a: 16, b: -16 });
  });

  it('uses the standard Elo expectation', () => {
    expect(eloExpected(1000, 1000)).toBe(0.5);
    expect(eloExpected(1400, 1000)).toBeCloseTo(10 / 11, 6);
  });
});
