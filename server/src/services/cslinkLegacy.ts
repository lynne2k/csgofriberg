import fs from 'fs';
import path from 'path';

export const CSLINK_PLAYER_ID = /^(?:hltv:[1-9]\d{0,9}|legacy:[a-f0-9]{20})$/;
const MAP_URL = /^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\/(\d+)\/[^/?#\s]+\/?$/;

/** Preserve the existing numeric order while giving local identities a stable order. */
export function compareCsLinkPlayerIds(a: string, b: string): number {
  const ah = a.startsWith('hltv:'), bh = b.startsWith('hltv:');
  if (ah && bh) return Number(a.slice(5)) - Number(b.slice(5));
  if (ah !== bh) return ah ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
export const cslinkPairKey = (a: string, b: string) => [a, b].sort(compareCsLinkPlayerIds).join('|');

/** Exact nickname matches must remain selectable even when many event identities share a name. */
export function cslinkSearchResults<T extends { nickname: string }>(items: T[], query: string): T[] {
  const raw = query.trim().normalize('NFC').toLowerCase();
  const exact = (item: T) => item.nickname.normalize('NFC').toLowerCase() === raw;
  return [...items.filter(exact), ...items.filter(item => !exact(item)).slice(0, 20)];
}

export interface LegacyPlayer {
  id: string; hltvId: string | null; nickname: string; profileUrl: string | null;
  identityKind: 'hltv' | 'legacy_context'; identityContext?: string;
  legacyMapCount: number; verifiedMapCount: number; candidateMapCount: number;
}
export interface LegacyMap {
  mapId: number; event: string; eventUrl: string; tier: string; map: string;
  dateRaw: string; sourceUrl: string; sourceFingerprint: string;
  opponents: string[]; score: number[];
  groups: { playerId: string; nickname: string; identityBasis: string }[][];
  sourceWarnings?: string[];
  droppedGroups?: unknown[];
}
export interface LegacyProof {
  mapId: number; event: string; eventUrl: string; tier: string; map: string; dateRaw: string;
  sourceUrl: string; sourceFingerprint: string; opponents: string[]; score: number[];
  team: string; lineup: LegacyPlayer[]; opponentLineup: LegacyPlayer[];
  sourceDataset: 'legacy_dataset'; scopeApproval: 'user_requested_legacy_import';
  scopeStatus: 'legacy_as_import'; reviewState: 'unreviewed';
}

/** Existing same-map five-player groups are sufficient evidence for teammate edges. */
export class CsLinkLegacy {
  private readonly players = new Map<string, LegacyPlayer>();
  private readonly aliases = new Map<string, Set<string>>();
  private readonly edges = new Map<string, LegacyProof[]>();

  private constructor(readonly version: string, readonly maps: readonly LegacyMap[],
    sourcePlayers: readonly Omit<LegacyPlayer, 'legacyMapCount' | 'verifiedMapCount' | 'candidateMapCount'>[]) {
    const sourceById = new Map(sourcePlayers.map(player => [player.id, player]));
    for (const map of maps) for (const group of map.groups) for (const row of group) {
      let player = this.players.get(row.playerId);
      if (!player) {
        player = { ...sourceById.get(row.playerId)!, legacyMapCount: 0,
          verifiedMapCount: 0, candidateMapCount: 0 };
        this.players.set(player.id, player);
        this.aliases.set(player.id, new Set([player.nickname]));
      }
      player.legacyMapCount++;
      this.aliases.get(player.id)!.add(row.nickname);
    }
    for (const map of maps) for (let groupIndex = 0; groupIndex < map.groups.length; groupIndex++) {
      const lineup = map.groups[groupIndex].map(row => ({ ...this.players.get(row.playerId)!, nickname: row.nickname }));
      // A map may keep only one usable five-player group; the other side is then unknown.
      const opponentLineup = (map.groups[1 - groupIndex] ?? []).map(row => ({ ...this.players.get(row.playerId)!, nickname: row.nickname }));
      const { groups: _groups, droppedGroups: _dropped, ...metadata } = map;
      const proof: LegacyProof = { ...metadata, team: '同队五人', lineup, opponentLineup,
        sourceDataset: 'legacy_dataset', scopeApproval: 'user_requested_legacy_import',
        scopeStatus: 'legacy_as_import', reviewState: 'unreviewed' };
      for (let i = 0; i < lineup.length; i++) for (let j = i + 1; j < lineup.length; j++) {
        const key = cslinkPairKey(lineup[i].id, lineup[j].id);
        const evidence = this.edges.get(key) ?? [];
        evidence.push(proof);
        this.edges.set(key, evidence);
      }
    }
    for (const evidence of this.edges.values()) evidence.sort((a, b) => b.mapId - a.mapId);
  }

  static open(directory: string): CsLinkLegacy | null {
    const file = path.join(path.resolve(directory), 'graph.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.schemaVersion !== 1 || typeof data.version !== 'string' ||
        !/^[a-f0-9]{20}$/.test(data.version) || !Array.isArray(data.players) || !Array.isArray(data.maps)) {
      throw new Error('CSLINK_LEGACY_INVALID_GRAPH');
    }
    const ids = new Set<string>();
    for (const player of data.players) {
      if (!player || typeof player.id !== 'string' || !CSLINK_PLAYER_ID.test(player.id) || ids.has(player.id) ||
          typeof player.nickname !== 'string' || !player.nickname.trim() ||
          (player.profileUrl !== null && typeof player.profileUrl !== 'string') ||
          (player.id.startsWith('hltv:') ? player.identityKind !== 'hltv' || player.hltvId !== player.id.slice(5) :
            player.identityKind !== 'legacy_context' || player.hltvId !== null ||
              typeof player.identityContext !== 'string' || !player.identityContext.trim())) {
        throw new Error('CSLINK_LEGACY_INVALID_PLAYER');
      }
      ids.add(player.id);
    }
    const maps = new Map<number, LegacyMap>();
    for (const map of data.maps as LegacyMap[]) {
      const match = typeof map?.sourceUrl === 'string' && MAP_URL.exec(map.sourceUrl);
      if (!Number.isSafeInteger(map?.mapId) || map.mapId < 1 || !match || Number(match[1]) !== map.mapId ||
          !/^[a-f0-9]{64}$/.test(map.sourceFingerprint) ||
          !['event', 'eventUrl', 'tier', 'map', 'dateRaw'].every(key => typeof (map as any)[key] === 'string') ||
          !Array.isArray(map.opponents) || map.opponents.length !== 2 ||
          !map.opponents.every(team => typeof team === 'string') ||
          !Array.isArray(map.score) || map.score.length !== 2 || !map.score.every(Number.isFinite) ||
          !Array.isArray(map.groups) || map.groups.length < 1 || map.groups.length > 2 ||
          !map.groups.every(group => Array.isArray(group) && group.length === 5 &&
            group.every(row => row && ids.has(row.playerId) && typeof row.nickname === 'string' &&
              !!row.nickname.trim() && typeof row.identityBasis === 'string')) ||
          new Set(map.groups.flat().map(row => row.playerId)).size !== 5 * map.groups.length) {
        throw new Error('CSLINK_LEGACY_INVALID_MAP');
      }
      // Repeated source rows do not create repeated maps or edges.
      if (!maps.has(map.mapId)) maps.set(map.mapId, map);
    }
    return new CsLinkLegacy(data.version, [...maps.values()], data.players);
  }

  excludingMaps(excluded: ReadonlySet<number>): CsLinkLegacy {
    if (!this.maps.some(map => excluded.has(map.mapId))) return this;
    return new CsLinkLegacy(this.version, this.maps.filter(map => !excluded.has(map.mapId)), this.allPlayers());
  }
  allPlayers() { return [...this.players.values()]; }
  pairs() { return [...this.edges.keys()].map(key => key.split('|') as [string, string]); }
  relationship(a: string, b: string) { return this.edges.get(cslinkPairKey(a, b)) ?? []; }
  searchAll(query: string) {
    const tokens = query.trim().normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
    return this.allPlayers().filter(player => {
      const searchable = [...this.aliases.get(player.id)!, player.identityContext ?? '']
        .join(' ').normalize('NFC').toLowerCase();
      return tokens.every(token => searchable.includes(token));
    });
  }
  metadata() {
    return { legacyVersion: this.version, legacyImportedMaps: this.maps.length,
      legacyInternalPlayers: this.allPlayers().filter(player => player.identityKind === 'legacy_context').length };
  }
}
