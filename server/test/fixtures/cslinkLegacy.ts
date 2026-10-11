import fs from 'fs';
import path from 'path';

export const legacyFixtureId = 'legacy:abcdef1234567890abcd';
export function legacyFixtureGraph() {
  const ids = ['hltv:3741', 'hltv:4679', legacyFixtureId, 'hltv:40001', 'hltv:40002',
    'hltv:20001', 'hltv:20002', 'hltv:20003', 'hltv:20004', 'hltv:20005'];
  const players = ids.map((id, i) => ({ id, hltvId: id.startsWith('hltv:') ? id.slice(5) : null,
    nickname: i === 0 ? 'NiKo' : i === 1 ? 'jks' : i === 2 ? 'sameName' : `Synthetic-${i}`,
    profileUrl: id.startsWith('hltv:') ? `https://www.hltv.org/player/${id.slice(5)}/synthetic` : null,
    identityKind: id.startsWith('hltv:') ? 'hltv' : 'legacy_context',
    ...(id.startsWith('legacy:') ? { identityContext: 'Synthetic old event / lineup 1' } : {}),
  }));
  const maps = [990101, 990102].map(mapId => ({ mapId, event: 'Synthetic old event',
    eventUrl: 'https://liquipedia.net/counterstrike/Synthetic_old_event', tier: 'S-Tier',
    map: 'Inferno', dateRaw: '2022-01-01 12:00',
    sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${mapId}/synthetic`,
    sourceFingerprint: 'f'.repeat(64), opponents: ['Old A', 'Old B'], score: [16, 10],
    groups: [players.slice(0, 5), players.slice(5)].map(group => group.map(player => ({
      playerId: player.id, nickname: player.id === 'hltv:4679' ? 'oldJksAlias' : player.nickname,
      identityBasis: player.identityKind === 'hltv' ? 'same_event_roster' : 'context_only',
    }))),
  }));
  return { schemaVersion: 1, version: 'f'.repeat(20), players, maps };
}
export function writeLegacyFixture(root: string, graph = legacyFixtureGraph()) {
  const directory = fs.mkdtempSync(path.join(root, 'legacy-'));
  fs.writeFileSync(path.join(directory, 'graph.json'), JSON.stringify(graph));
  return directory;
}
