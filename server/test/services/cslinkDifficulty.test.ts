import { describe, expect, it } from 'vitest';
import { buildCsLinkDifficultyFilters, CSLINK_DIFFICULTIES } from '../../src/services/cslinkDifficulty';
import { CsLinkPathGraph } from '../../src/services/cslinkPaths';

const id = (n: number) => `hltv:${n}`;
const link = (a: number, b: number) => ({ a: id(a), b: id(b), evidenceCount: 1, proof: { mapId: a * 1000 + b,
  sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${a * 1000 + b}/x`, sourceFingerprint: 'b'.repeat(64),
  lineup: [{ id: id(a) }, { id: id(b) }] } });

describe('CS Link difficulty tiers', () => {
  it('ranks only allowed endpoints by map count and keeps tiers nested', () => {
    const ids = Array.from({ length: 500 }, (_, i) => id(i + 1));
    const { filters, ranked } = buildCsLinkDifficultyFilters(ids, x => x !== id(1), x => 1000 - Number(x.slice(5)));
    expect(ranked[0]).toBe(id(2));
    expect(ranked).not.toContain(id(1));
    expect(filters.easy(id(2))).toBe(true);
    expect(filters.easy(id(1))).toBe(false);
    expect(filters.easy(id(CSLINK_DIFFICULTIES.easy.topN + 2))).toBe(false);
    expect(filters.normal(id(CSLINK_DIFFICULTIES.easy.topN + 2))).toBe(true);
    expect(filters.hell(id(500))).toBe(true);
    for (const x of ranked) {
      if (filters.easy(x)) expect(filters.normal(x)).toBe(true);
      if (filters.normal(x)) expect(filters.hard(x)).toBe(true);
      if (filters.hard(x)) expect(filters.hell(x)).toBe(true);
    }
  });

  it('caches missing pairs per tier instead of sharing one filtered cache', () => {
    const g = new CsLinkPathGraph('1234567890abcdef1234', [link(1, 2), link(2, 3), link(3, 4)]);
    const near = new Set([id(1), id(2)]), far = new Set([id(1), id(4)]);
    expect(g.sampleDistantPair(3, 3, 8, () => 0, x => near.has(x), 'tier:easy')).toBeNull();
    expect(g.sampleDistantPair(3, 3, 8, () => 0, x => far.has(x), 'tier:hard')).toMatchObject({ shortestJumps: 3 });
  });
});
