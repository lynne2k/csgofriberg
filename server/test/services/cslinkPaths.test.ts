import { describe, expect, it } from 'vitest';
import type { VerifiedLink } from '../../src/services/cslinkQuestions';
import {
  bestCsLinkPathFinish, compareCsLinkPathFinishes, CsLinkPathGraph,
  settleCsLinkPathRound, type CsLinkPathLink, type CsLinkPathRound,
} from '../../src/services/cslinkPaths';

// Synthetic fixtures only; these are not historical maps or an approved A/S question bank.
const id = (n: number) => `cs-person-${String(n).padStart(6, '0')}`;
const link = (a: number, b: number): VerifiedLink => ({
  a: id(a), b: id(b), evidenceCount: 1,
  proof: {
    mapId: a * 100 + b, event: 'Synthetic', map: 'Mirage', dateRaw: '2026-01-01', timezone: 'unknown',
    team: 'Fixture', opponents: ['Fixture', 'Opponent'], score: [13, 0],
    sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${a * 100 + b}/fixture`,
    lineup: [a, b].map(n => ({ id: id(n), nickname: n === 1 ? 'NiKo' : n === 2 ? 'niko' : `Fixture ${n}`,
      name: null, hltvId: String(n), profileUrl: `https://www.hltv.org/player/${n}/fixture`, verifiedMapCount: 1 })),
    review: { status: 'verified', reviewedBy: 'fixture', reviewedOn: '2026-10-03' },
    recordSha256: 'a'.repeat(64), sourceRefs: {},
  },
});
const version = '1234567890abcdef1234';
const graph = () => new CsLinkPathGraph(version, [
  link(1, 2), link(2, 3), link(3, 4), link(4, 5), link(2, 6), link(6, 4),
  link(3, 7), link(7, 6),
]);
const round: CsLinkPathRound = {
  roundId: 'fixture-round', dataVersion: version,
  startId: id(1), endId: id(5), serverStartedAtMs: 1_000,
  serverDeadlineAtMs: 11_000, maxJumps: 8,
};
const finish = (route: number[], at: number) => {
  const result = graph().finish(round, route.map(id), at);
  if (!result.valid) throw new Error(result.reason);
  return result.finish;
};

describe('CS Link path duel rules', () => {
  it('finds only confirmed graph distances and samples endpoints at the required separation', () => {
    const g = graph();
    expect(g.shortestJumps(id(1), id(5))).toBe(4);
    expect(g.shortestJumps(id(1), id(1))).toBe(0);
    expect(g.shortestJumps(id(1), id(99))).toBeNull();
    const selected = g.sampleDistantPair(3, 4, 6, () => 0)!;
    expect(selected).toMatchObject({ dataVersion: version });
    expect(g.shortestJumps(selected.startId, selected.endId)).toBe(selected.shortestJumps);
    expect(selected.shortestJumps).toBeGreaterThanOrEqual(3);
    expect(selected.shortestJumps).toBeLessThanOrEqual(4);
    expect(g.sampleDistantPair(6, 7, 6, () => 0)).toBeNull();
    expect(() => g.sampleDistantPair(0)).toThrow('CSLINK_PATH_INVALID_DISTANCE_RANGE');
    const sparse = new CsLinkPathGraph(version, [link(1, 2), link(2, 3), link(3, 4), link(5, 6)]);
    // The one random source is a dead end; the fallback still finds a valid distant pair.
    expect(sparse.sampleDistantPair(3, 3, 1, n => n - 1)).toMatchObject({
      startId: id(1), endId: id(4), shortestJumps: 3,
    });
    expect(sparse.sampleDistantPair(4, 4, 1, n => n - 1)).toBeNull();
  });

  it('publishes one stable shortest route with HLTV evidence for every hop', () => {
    const g = graph();
    const answer = g.shortestRoute(id(1), id(5))!;
    expect(answer.routeIds).toHaveLength(5);
    expect(answer.routeIds[0]).toBe(id(1));
    expect(answer.routeIds.at(-1)).toBe(id(5));
    expect(g.shortestRoute(id(1), id(5))).toEqual(answer);
    answer.hops.forEach((hop, i) => {
      expect(hop).toMatchObject({ fromId: answer.routeIds[i], toId: answer.routeIds[i + 1] });
      expect(hop.evidence.sourceUrl).toMatch(/^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\//);
    });
    // Blocking person 6 forces the 3 -> 4 route; blocking 3 and 6 leaves no route.
    expect(g.shortestRoute(id(1), id(5), x => x !== id(6))!.routeIds).toEqual([1, 2, 3, 4, 5].map(id));
    expect(g.shortestRoute(id(1), id(5), x => x !== id(6) && x !== id(3))).toBeNull();
    expect(g.shortestRoute(id(1), id(99))).toBeNull();
  });

  it('prefers endpoints that pass the filter and falls back when none qualify', () => {
    const sparse = new CsLinkPathGraph(version, [link(1, 2), link(2, 3), link(3, 4), link(4, 5)]);
    const allowed = new Set([id(2), id(5)]);
    const picked = sparse.sampleDistantPair(3, 3, 8, () => 0, x => allowed.has(x))!;
    expect([picked.startId, picked.endId].sort()).toEqual([id(2), id(5)]);
    expect(sparse.sampleDistantPair(3, 3, 8, () => 0, () => false)).toMatchObject({ shortestJumps: 3 });
  });

  it('never falls back to filtered-out endpoints once the filter has candidates', () => {
    const sparse = new CsLinkPathGraph(version, [link(1, 2), link(2, 3), link(3, 4), link(4, 5)]);
    // 1 and 2 are only one jump apart, so no allowed pair reaches 3 jumps; 1→4 exists but 4 is filtered out.
    const allowed = new Set([id(1), id(2)]);
    expect(sparse.sampleDistantPair(3, 3, 8, () => 0, x => allowed.has(x))).toBeNull();
    // Inactive players still bridge: allowed endpoints 1 and 5 connect through filtered-out 2, 3, 4.
    const ends = new Set([id(1), id(5)]);
    expect(sparse.sampleDistantPair(4, 4, 8, () => 0, x => ends.has(x))).toMatchObject({ shortestJumps: 4 });
    // The unfiltered range is cached separately from the filtered one.
    expect(sparse.sampleDistantPair(3, 3, 8, () => 0)).toMatchObject({ shortestJumps: 3 });
  });

  it('accepts every proven hop by stable ID and returns source references for each jump', () => {
    const result = graph().finish(round, [1, 2, 3, 4, 5].map(id), 3_000);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.finish).toMatchObject({ roundId: 'fixture-round', jumps: 4, elapsedMs: 2_000 });
    expect(result.finish.hops.map(hop => [hop.fromId, hop.toId, hop.evidence.mapId])).toEqual([
      [id(1), id(2), 102], [id(2), id(3), 203], [id(3), id(4), 304], [id(4), id(5), 405],
    ]);
    expect(result.finish.hops.every(hop => hop.evidence.sourceUrl.startsWith('https://www.hltv.org/'))).toBe(true);
    // NiKo and niko have distinct stable IDs; their similar nicknames are never consulted.
    expect(result.finish.routeIds.slice(0, 2)).toEqual([id(1), id(2)]);
  });

  it('rejects invented, cyclic, wrong-endpoint, expired, stale-version, and oversized routes', () => {
    const g = graph();
    const reason = (route: number[], at = 3_000, change: Partial<CsLinkPathRound> = {}) => {
      const result = g.finish({ ...round, ...change }, route.map(id), at);
      return result.valid ? 'valid' : result.reason;
    };
    expect(reason([1, 3, 4, 5])).toBe('unverified_jump');
    expect(reason([1, 2, 99, 5])).toBe('unknown_player');
    expect(reason([1, 2, 3, 2, 6, 4, 5])).toBe('repeated_player');
    expect(reason([2, 3, 4, 5])).toBe('wrong_endpoints');
    expect(reason([1, 2, 3, 4])).toBe('wrong_endpoints');
    expect(reason([1, 2, 3, 4, 5], 11_001)).toBe('after_deadline');
    expect(reason([1, 2, 3, 4, 5], 999)).toBe('invalid_time');
    expect(reason([1, 2, 3, 4, 5], 3_000, { dataVersion: 'changed' })).toBe('version_changed');
    expect(reason([1, 2, 3, 4, 5], 3_000, { maxJumps: 3 })).toBe('too_many_jumps');
  });

  it('uses fewest jumps first, with server elapsed time resolving equal jumps', () => {
    const shorter = finish([1, 2, 3, 4, 5], 8_000);
    const equallyShortFaster = finish([1, 2, 6, 4, 5], 4_000);
    const longerButFirst = finish([1, 2, 3, 7, 6, 4, 5], 2_000);
    expect(compareCsLinkPathFinishes(longerButFirst, shorter)).toBe(1);
    expect(compareCsLinkPathFinishes(equallyShortFaster, shorter)).toBe(-1);
    expect(bestCsLinkPathFinish([longerButFirst, shorter, equallyShortFaster]))
      .toBe(equallyShortFaster);
  });

  it('keeps the earliest submission at the best jump count, even if finishes arrive unordered', () => {
    const earlier = finish([1, 2, 3, 4, 5], 3_000);
    const later = finish([1, 2, 6, 4, 5], 8_000);
    expect(bestCsLinkPathFinish([later, earlier])).toBe(earlier);
    expect(bestCsLinkPathFinish([earlier, later])).toBe(earlier);
    expect(compareCsLinkPathFinishes(earlier, { ...earlier })).toBe(0);
    expect(() => compareCsLinkPathFinishes(earlier,
      { ...earlier, dataVersion: 'changed' })).toThrow('CSLINK_PATH_VERSION_MISMATCH');
    expect(() => compareCsLinkPathFinishes(earlier,
      { ...earlier, roundId: 'different' })).toThrow('CSLINK_PATH_ROUND_MISMATCH');
  });

  it('accepts server receipt exactly at the deadline and rejects even one millisecond later', () => {
    const route = [1, 2, 3, 4, 5].map(id);
    const atDeadline = graph().finish(round, route, round.serverDeadlineAtMs);
    expect(atDeadline).toMatchObject({ valid: true, finish: {
      serverCompletedAtMs: 11_000, elapsedMs: 10_000,
    } });
    expect(graph().finish(round, route, round.serverDeadlineAtMs + 1))
      .toEqual({ valid: false, reason: 'after_deadline' });
  });

  it('refuses unreviewed, ambiguous, duplicated, and self-linked edges', () => {
    expect(() => new CsLinkPathGraph(version, [link(1, 1)])).toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [link(1, 2), link(2, 1)])).toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [{ ...link(1, 2), b: id(3) }])).toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [{ ...link(1, 2), a: 'NiKo' }]))
      .toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [{ ...link(1, 2), proof: {
      ...link(1, 2).proof, review: { ...link(1, 2).proof.review, status: 'unreviewed' as 'verified' },
    } }])).toThrow('CSLINK_PATH_INVALID_EDGE');
  });

  it('pins proof references even if the original link object changes later', () => {
    const first = link(1, 2);
    const g = new CsLinkPathGraph(version, [first, link(2, 3)]);
    const expectedUrl = first.proof.sourceUrl;
    first.proof.sourceUrl = 'https://example.org/changed-after-build';
    const result = g.finish({ ...round, endId: id(3) }, [1, 2, 3].map(id), 3_000);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.finish.hops[0].evidence.sourceUrl).toBe(expectedUrl);
  });

  it('uses imported and captured lineup evidence without requiring individual map review', () => {
    const internal = 'legacy:abcdef1234567890abcd';
    const ids = ['hltv:3741', internal, 'hltv:4679', 'hltv:10264'];
    const links: CsLinkPathLink[] = ids.slice(1).map((to, index) => ({
      a: ids[index], b: to, evidenceCount: index + 1,
      proof: { mapId: 700 + index,
        sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${700 + index}/synthetic`,
        sourceFingerprint: 'f'.repeat(64), lineup: [{ id: ids[index] }, { id: to }] },
    }));
    const g = new CsLinkPathGraph(version, links);
    const pair = g.sampleDistantPair(3, 6, 32, () => 0)!;
    expect(pair).toMatchObject({ startId: 'hltv:10264', endId: 'hltv:3741', shortestJumps: 3 });
    const result = g.finish({ ...round, startId: ids[0], endId: ids[3] }, ids, 4_000);
    expect(result).toMatchObject({ valid: true, finish: { jumps: 3, routeIds: ids,
      hops: [{ evidence: { mapId: 700, recordSha256: 'f'.repeat(64) } },
        { evidence: { mapId: 701 } }, { evidence: { mapId: 702 } }] } });
    links[0].proof.sourceFingerprint = 'b'.repeat(64);
    const unchanged = g.finish({ ...round, startId: ids[0], endId: ids[3] }, ids, 4_000);
    expect(unchanged.valid && unchanged.finish.hops[0].evidence.recordSha256).toBe('f'.repeat(64));
    expect(() => new CsLinkPathGraph(version, [{ ...links[0], proof: {
      ...links[0].proof, sourceUrl: 'https://example.org/700' } }])).toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [{ ...links[0], proof: {
      ...links[0].proof, mapId: 999 } }])).toThrow('CSLINK_PATH_INVALID_EDGE');
    expect(() => new CsLinkPathGraph(version, [{ ...links[0], proof: {
      ...links[0].proof, lineup: [...links[0].proof.lineup, { id: internal }] } }]))
      .toThrow('CSLINK_PATH_INVALID_EDGE');
  });
});

describe('round settlement', () => {
  const settle = (left: ReturnType<typeof finish>[], right: ReturnType<typeof finish>[]) =>
    settleCsLinkPathRound(round, [
      { playerKey: 'player-a', finishes: left },
      { playerKey: 'player-b', finishes: right },
    ]);

  it('draws when neither competitor connected', () => {
    expect(settle([], [])).toEqual({
      winnerKey: null, reason: 'both_incomplete',
      participants: [
        { playerKey: 'player-a', bestFinish: null },
        { playerKey: 'player-b', bestFinish: null },
      ],
    });
  });

  it('awards the round to the only competitor with a valid finish', () => {
    const completed = finish([1, 2, 3, 4, 5], 3_000);
    const result = settle([], [completed]);
    expect(result).toMatchObject({ winnerKey: 'player-b', reason: 'one_completed' });
    expect(result.participants[1].bestFinish).toBe(completed);
  });

  it('uses a later shorter route’s own submission time, not the first longer connection time', () => {
    const earlyLonger = finish([1, 2, 3, 7, 6, 4, 5], 2_000);
    const laterShorter = finish([1, 2, 3, 4, 5], 7_000);
    const opponent = finish([1, 2, 6, 4, 5], 6_000);
    const result = settle([earlyLonger, laterShorter], [opponent]);
    expect(result).toMatchObject({ winnerKey: 'player-b', reason: 'faster_time' });
    expect(result.participants[0].bestFinish).toBe(laterShorter);
    expect(result.participants[0].bestFinish).toMatchObject({ jumps: 4, elapsedMs: 6_000 });
  });

  it('ignores a shorter route submitted after the deadline', () => {
    const earlyLonger = finish([1, 2, 3, 7, 6, 4, 5], 2_000);
    const expiredShorter = graph().finish(round, [1, 2, 3, 4, 5].map(id), 11_001);
    expect(expiredShorter).toEqual({ valid: false, reason: 'after_deadline' });
    const accepted = [earlyLonger];
    if (expiredShorter.valid) accepted.push(expiredShorter.finish);
    const opponent = finish([1, 2, 6, 4, 5], 11_000);
    const result = settle(accepted, [opponent]);
    expect(result).toMatchObject({ winnerKey: 'player-b', reason: 'fewer_jumps' });
    expect(result.participants[0].bestFinish).toBe(earlyLonger);
  });

  it('counts disconnected or expired submissions as incomplete', () => {
    const results = [
      graph().finish(round, [1, 3, 4, 5].map(id), 3_000),
      graph().finish(round, [1, 2, 3, 4, 5].map(id), 11_001),
    ];
    expect(results.every(result => !result.valid)).toBe(true);
    const accepted = results.flatMap(result => result.valid ? [result.finish] : []);
    expect(settle(accepted, [])).toMatchObject({ winnerKey: null, reason: 'both_incomplete' });
  });

  it('keeps a true draw when both have the same deciding score', () => {
    const first = finish([1, 2, 3, 4, 5], 4_000);
    const otherRoute = finish([1, 2, 6, 4, 5], 4_000);
    expect(settle([first], [otherRoute])).toMatchObject({ winnerKey: null, reason: 'exact_tie' });
  });
});

describe('settlement isolation', () => {
  it('lets fewer jumps beat an earlier valid connection', () => {
    const earlyLonger = finish([1, 2, 3, 7, 6, 4, 5], 2_000);
    const laterShorter = finish([1, 2, 3, 4, 5], 8_000);
    expect(settleCsLinkPathRound(round, [
      { playerKey: 'player-a', finishes: [earlyLonger] },
      { playerKey: 'player-b', finishes: [laterShorter] },
    ])).toMatchObject({ winnerKey: 'player-b', reason: 'fewer_jumps' });
  });

  it('refuses to mix versions, rounds, or player identities', () => {
    const completed = finish([1, 2, 3, 4, 5], 3_000);
    const competitors = (a: ReturnType<typeof finish>, b = completed) => [
      { playerKey: 'player-a', finishes: [a] }, { playerKey: 'player-b', finishes: [b] },
    ] as const;
    expect(() => settleCsLinkPathRound(round,
      competitors({ ...completed, dataVersion: 'changed' }))).toThrow('CSLINK_PATH_VERSION_MISMATCH');
    expect(() => settleCsLinkPathRound(round,
      competitors({ ...completed, roundId: 'different' }))).toThrow('CSLINK_PATH_ROUND_MISMATCH');
    expect(() => settleCsLinkPathRound(round, [
      { playerKey: 'same', finishes: [] }, { playerKey: 'same', finishes: [] },
    ])).toThrow('CSLINK_PATH_INVALID_SETTLEMENT');
  });
});
