import { describe, expect, it } from 'vitest';
import { buildQuestionBank, VerifiedLink } from '../../src/services/cslinkQuestions';

// Synthetic graph proofs, not historical evidence.
const id = (n: number) => `cs-person-${String(n).padStart(6, '0')}`;
const link = (a: number, b: number): VerifiedLink => ({ a: id(a), b: id(b), evidenceCount: 1,
  proof: { mapId: a * 100 + b, event: 'Synthetic', map: 'Mirage', dateRaw: `${2000 + a}-01-01`, timezone: 'unknown',
    team: `Fixture ${a}`, opponents: ['Fixture A', 'Fixture B'], score: [16, 0],
    sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${a * 100 + b}/fixture`,
    lineup: [a, b].map(n => ({ id: id(n), nickname: n === 1 ? 'NiKo' : n === 2 ? 'niko' : `Fixture ${n}`,
      name: null, hltvId: String(n), profileUrl: `https://www.hltv.org/player/${n}/fixture`, verifiedMapCount: 1 })),
    review: { status: 'verified', reviewedBy: 'fixture', reviewedOn: '2026-10-03' }, recordSha256: 'a'.repeat(64), sourceRefs: {} },
});
const version = '1234567890abcdef1234';
const between = (links: VerifiedLink[], a: number, b: number) => buildQuestionBank(version, links).questions.find(q => q.playerA === id(a) && q.playerB === id(b));

describe('common teammate generation', () => {
  it('accepts all common neighbors, preserving two-sided evidence from different teams and years', () => {
    const q = between([link(1, 3), link(2, 3), link(1, 4), link(2, 4)], 1, 2)!;
    expect(q.answerIds).toEqual([id(3), id(4)]);
    expect(q.answers.map(a => [a.left.mapId, a.right.mapId])).toEqual([[103, 203], [104, 204]]);
    expect(q.endpointsHaveConfirmedEdge).toBe(false);
    expect(q.reviewStatus).toBe('pending'); expect(q.eligibleForRelease).toBe(false);
  });
  it('keeps NiKo and niko as distinct middle players despite similar names', () => {
    expect(between([link(1, 3), link(1, 4), link(2, 3)], 3, 4)?.answerIds).toEqual([id(1)]);
    expect(between([link(2, 3), link(2, 4), link(1, 3)], 3, 4)?.answerIds).toEqual([id(2)]);
  });
  it('excludes endpoints and never infers missing or transitive edges', () => {
    const graph = [link(1, 2), link(2, 3), link(3, 4)];
    expect(between(graph, 1, 2)).toBeUndefined();
    expect(between(graph, 1, 3)?.answerIds).toEqual([id(2)]);
    expect(between(graph, 1, 4)).toBeUndefined();
    expect(buildQuestionBank(version, graph).questions.every(q => q.playerA !== q.playerB)).toBe(true);
  });
  it('drops an entire question with too many answers instead of truncating the legal set', () => {
    const graph = [3, 4, 5, 6].flatMap(n => [link(1, n), link(2, n)]);
    expect(between(graph, 1, 2)).toBeUndefined();
  });
  it('is deterministic under shuffled edge order and symmetric edge direction', () => {
    const graph = [link(1, 3), link(2, 3), link(2, 4), link(1, 4)];
    const bank = buildQuestionBank(version, graph);
    expect(buildQuestionBank(version, [...graph].reverse().map(e => ({ ...e, a: e.b, b: e.a })))).toEqual(bank);
    expect(buildQuestionBank('0'.repeat(20), graph).bankVersion).not.toBe(bank.bankVersion);
    expect(buildQuestionBank(version, graph.slice(1)).bankVersion).not.toBe(bank.bankVersion);
  });
  it('rejects self-links, duplicate links and proofs missing an endpoint', () => {
    expect(() => buildQuestionBank(version, [link(1, 1)])).toThrow('CSLINK_INVALID_GRAPH_EDGE');
    expect(() => buildQuestionBank(version, [link(1, 2), link(2, 1)])).toThrow('CSLINK_INVALID_GRAPH_EDGE');
    expect(() => buildQuestionBank(version, [{ ...link(1, 2), b: id(3) }])).toThrow('CSLINK_INVALID_GRAPH_EDGE');
    expect(buildQuestionBank(version, []).questions).toEqual([]);
  });
});
