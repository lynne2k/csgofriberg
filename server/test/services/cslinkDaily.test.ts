/** Synthetic graph only (fixtures/cslinkRooms.ts); covers daily timing, best result and ranking. */
import { beforeEach, describe, expect, it } from 'vitest';
import { CsLinkDaily, resetCsLinkDailyMemory } from '../../src/services/cslinkDaily';
import { id, longRoute, roomFixture, shortRoute } from '../fixtures/cslinkRooms';

describe('CS Link daily challenge', () => {
  let now = Date.UTC(2026, 9, 11, 4, 0, 0);
  const make = () => new CsLinkDaily(roomFixture(), undefined, () => now);
  beforeEach(() => { resetCsLinkDailyMemory(); now = Date.UTC(2026, 9, 11, 4, 0, 0); });

  it('gives everyone the same Shanghai-day question', () => {
    const a = make().today()!, b = make().today()!;
    expect(a).toMatchObject({ date: '2026-10-11', no: 1, start: { id: id(1) }, end: { id: id(4) } });
    expect(b.start.id).toBe(a.start.id);
    expect(a.nextRefreshAt).toBe(Date.UTC(2026, 9, 11, 16, 0, 0));
  });

  it('times from the first placed card, keeps the best route and ranks jumps before time', async () => {
    const daily = make();
    const today = daily.today()!;
    const input = (routeIds: string[]) => ({ date: today.date, dataVersion: today.dataVersion, routeIds });
    expect(await daily.submit('g:a', 'A', input(shortRoute))).toEqual({ code: 'NOT_STARTED' });

    await daily.start('g:a', 'A');
    await daily.start('g:b', 'B');
    await daily.start('g:c', 'C');
    // 只打开页面不计时：这 60 秒不算进成绩
    now += 60_000;
    expect(await daily.submit('g:a', 'A', input(shortRoute))).toEqual({ code: 'NOT_STARTED' });
    await daily.begin('g:a', 'A'); await daily.begin('g:b', 'B'); await daily.begin('g:c', 'C');
    now += 5_000;
    // 重复 start / begin 都不重置计时
    await daily.start('g:a', 'A'); await daily.begin('g:a', 'A');
    const longA = await daily.submit('g:a', 'A', input(longRoute));
    expect(longA).toMatchObject({ improved: true, finish: { jumps: 4, elapsedMs: 5_000 } });
    now += 5_000;
    const shortA = await daily.submit('g:a', 'A', input(shortRoute));
    expect(shortA).toMatchObject({ improved: true, finish: { jumps: 3, elapsedMs: 10_000 } });
    expect((shortA as any).finish.hops[0].evidence.sourceUrl).toMatch(/^https:\/\/www\.hltv\.org\//);
    now += 1_000;
    expect(await daily.submit('g:a', 'A', input(longRoute))).toMatchObject({ improved: false });
    expect(await daily.submit('g:b', 'B', input(longRoute))).toMatchObject({ finish: { jumps: 4 } });
    expect(await daily.submit('g:c', 'C', input([id(1), id(3), id(4)])))
      .toMatchObject({ code: 'INVALID_PATH', reason: 'unverified_jump' });

    const board = await daily.leaderboard('g:c', 10) as any;
    expect(board.top.map((row: any) => [row.name, row.jumps, row.elapsedMs]))
      .toEqual([['A', 3, 10_000], ['B', 4, 11_000]]);
    expect(board).toMatchObject({ players: 3, finished: 2, me: { name: 'C', rank: null, attempts: 1 } });
  });

  it('rejects a submit for yesterday after the day rolls over', async () => {
    const daily = make();
    const today = daily.today()!;
    await daily.start('g:a', 'A');
    await daily.begin('g:a', 'A');
    now = today.nextRefreshAt + 1;
    expect(await daily.submit('g:a', 'A', { date: today.date, dataVersion: today.dataVersion, routeIds: shortRoute }))
      .toEqual({ code: 'DAILY_EXPIRED' });
  });
});
