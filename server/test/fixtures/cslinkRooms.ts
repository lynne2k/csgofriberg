import { CsLinkPathGraph, CsLinkPathLink } from '../../src/services/cslinkPaths';
import type { CsLinkRoomStore } from '../../src/services/cslinkRooms';
import type { PlayPlayer } from '../../src/services/cslinkPlay';

export const id = (n: number) => `hltv:${n}`;
export const shortRoute = [1, 2, 3, 4].map(id);
export const longRoute = [1, 5, 6, 3, 4].map(id);
export function roomFixture(): CsLinkRoomStore {
  const links: CsLinkPathLink[] = [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 3]].map(([a, b]) => ({
    a: id(a), b: id(b), evidenceCount: 1,
    proof: { mapId: a * 100 + b,
      sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${a * 100 + b}/fixture`,
      sourceFingerprint: 'a'.repeat(64), lineup: [{ id: id(a) }, { id: id(b) }] },
  }));
  const graph = new CsLinkPathGraph('1234567890abcdef1234', links);
  // Pin a valid three-hop pair; endpoint randomness is tested separately in cslinkPaths.test.ts.
  graph.sampleDistantPair = () => ({ startId: id(1), endId: id(4), shortestJumps: 3, dataVersion: graph.dataVersion });
  return {
    pathGraph: () => graph,
    getPathPlayer: (playerId): PlayPlayer | null => {
      const num = Number(playerId.split(':')[1]);
      return num >= 1 && num <= 6 ? { id: playerId, hltvId: String(num),
        nickname: num === 1 ? 'NiKo' : num === 2 ? 'niko' : `Fixture${num}`,
        profileUrl: `https://www.hltv.org/player/${num}/fixture`, verifiedMapCount: 0, candidateMapCount: 1 } : null;
    },
  };
}
