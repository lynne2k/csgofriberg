import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CsLinkLegacy } from '../../src/services/cslinkLegacy';
import { writeLegacyFixture } from '../fixtures/cslinkLegacy';

// These are the actual manually checked map IDs; this verifies loading and proof retention,
// not live HLTV availability. Source-page verification is documented in the feedback report.
it('imports reported teammate pairs with their specific HLTV map proofs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-manual-'));
  try {
    const directory = writeLegacyFixture(root);
    const manual = path.resolve(__dirname, '../../../data/cslink/manual-relations.json');
    const graph = CsLinkLegacy.open(directory, manual)!;
    for (const [a, b, mapId] of [[16872, 20807, 138298], [20254, 19645, 180671],
      [23600, 24177, 193632], [18987, 19230, 112006], [23600, 23320, 167550]]) {
      const proof = graph.relationship(`hltv:${a}`, `hltv:${b}`).find(p => p.mapId === mapId);
      expect(proof?.sourceUrl).toContain(`/mapstatsid/${mapId}/`);
      expect(proof?.lineup).toHaveLength(5);
    }
    expect(graph.allPlayers().find(p => p.id === 'hltv:18987')?.nickname).toBe('b1t');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
