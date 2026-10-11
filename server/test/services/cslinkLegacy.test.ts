import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsLinkLegacy, compareCsLinkPlayerIds } from '../../src/services/cslinkLegacy';
import { CsLinkMerged } from '../../src/services/cslinkMerged';
import { buildCsLinkQuestionBank } from '../../src/services/cslinkPlay';
import { legacyFixtureGraph, legacyFixtureId, writeLegacyFixture } from '../fixtures/cslinkLegacy';

let temp: string;
beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-legacy-test-')); });
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

describe('old-library same-team relationships', () => {
  it('keeps many match links without duplicating the relationship or inventing a player profile', () => {
    const input = legacyFixtureGraph();
    input.maps.push(structuredClone(input.maps[0]));
    const legacy = CsLinkLegacy.open(writeLegacyFixture(temp, input))!;
    expect(legacy.maps).toHaveLength(2);
    expect(legacy.pairs()).toHaveLength(20);
    expect(legacy.relationship('hltv:3741', legacyFixtureId)).toHaveLength(2);
    expect(legacy.searchAll('oldJksAlias').map(player => player.id)).toEqual(['hltv:4679']);
    expect(legacy.searchAll('sameName')[0]).toMatchObject({ id: legacyFixtureId,
      hltvId: null, profileUrl: null, identityKind: 'legacy_context', legacyMapCount: 2 });
    const merged = new CsLinkMerged(null, null, null, null, legacy);
    expect(merged.metadata()).toMatchObject({ sampledMaps: 2, legacyImportedMaps: 2,
      distinctPairs: 20, legacyInternalPlayers: 1 });
    const result = merged.relationship('hltv:3741', legacyFixtureId, merged.version, 0);
    expect(result).toMatchObject({ total: 2, candidateTotal: 2 });
    expect(result.evidence[0]).toMatchObject({ sourceDataset: 'legacy_dataset',
      team: '同队五人', scopeStatus: 'legacy_as_import', reviewState: 'unreviewed' });
  });

  it('paginates every distinct supporting map, and the same nickname in different contexts stays separate', () => {
    const input = legacyFixtureGraph();
    input.maps = Array.from({ length: 55 }, (_, i) => ({ ...input.maps[0], mapId: 880001 + i,
      sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${880001 + i}/synthetic` }));
    const otherId = 'legacy:1234567890abcdef1234';
    input.players.push({ ...input.players[2], id: otherId, identityContext: 'Another event / lineup 2' });
    input.maps[54] = structuredClone(input.maps[54]);
    input.maps[54].groups[0][2].playerId = otherId;
    const legacy = CsLinkLegacy.open(writeLegacyFixture(temp, input))!;
    const merged = new CsLinkMerged(null, null, null, null, legacy);
    expect(merged.search('sameName').items.map(player => player.id)).toEqual([legacyFixtureId, otherId]);
    const first = merged.relationship('hltv:3741', legacyFixtureId, merged.version, 0);
    const second = merged.relationship('hltv:3741', legacyFixtureId, merged.version, 50);
    expect(first).toMatchObject({ total: 54, hasMore: true });
    expect(first.evidence).toHaveLength(50);
    expect(second).toMatchObject({ total: 54, hasMore: false });
    expect(second.evidence).toHaveLength(4);
    expect(new Set([...first.evidence, ...second.evidence].map(proof => proof.mapId)).size).toBe(54);
    expect(legacy.relationship(legacyFixtureId, otherId)).toHaveLength(0);
  });

  it('refuses mismatched map links and malformed five-player groups without requiring manual review', () => {
    for (const mutate of [
      (input: ReturnType<typeof legacyFixtureGraph>) => { input.maps[0].sourceUrl = 'https://www.hltv.org/stats/matches/mapstatsid/1/wrong'; },
      (input: ReturnType<typeof legacyFixtureGraph>) => { input.maps[0].groups[0].pop(); },
      (input: ReturnType<typeof legacyFixtureGraph>) => { input.maps[0].groups[1][0].playerId = input.maps[0].groups[0][0].playerId; },
      (input: ReturnType<typeof legacyFixtureGraph>) => { input.maps[0].groups = []; },
    ]) {
      const input = legacyFixtureGraph(); mutate(input);
      expect(() => CsLinkLegacy.open(writeLegacyFixture(temp, input))).toThrow('CSLINK_LEGACY_INVALID_MAP');
    }
  });

  it('accepts a map that kept only one usable five-player group', () => {
    const input = legacyFixtureGraph();
    input.maps = [{ ...input.maps[0], groups: [input.maps[0].groups[0]] }];
    const legacy = CsLinkLegacy.open(writeLegacyFixture(temp, input))!;
    expect(legacy.pairs()).toHaveLength(10);
    const proof = legacy.relationship('hltv:3741', legacyFixtureId)[0];
    expect(proof.opponentLineup).toEqual([]);
    expect(proof.sourceUrl).toBe(input.maps[0].sourceUrl);
    expect(legacy.relationship('hltv:20001', 'hltv:20002')).toHaveLength(0);
  });

  it('orders mixed identities deterministically and never duplicates two-hop questions', () => {
    const localA = 'legacy:aaaaaaaaaaaaaaaaaaaa', localB = 'legacy:bbbbbbbbbbbbbbbbbbbb';
    const entries: [string, Set<string>][] = [
      ['hltv:2', new Set([localA, 'hltv:10'])],
      [localA, new Set(['hltv:2', localB])],
      ['hltv:10', new Set(['hltv:2', localB])],
      [localB, new Set([localA, 'hltv:10'])],
    ];
    expect([localB, 'hltv:10', localA, 'hltv:2'].sort(compareCsLinkPlayerIds))
      .toEqual(['hltv:2', 'hltv:10', localA, localB]);
    const first = buildCsLinkQuestionBank(new Map(entries), 'a'.repeat(20));
    const second = buildCsLinkQuestionBank(new Map([...entries].reverse()), 'a'.repeat(20));
    expect(first).toEqual(second);
    expect(new Set(first.questions.map(question => question.id)).size).toBe(first.questions.length);
  });
});
