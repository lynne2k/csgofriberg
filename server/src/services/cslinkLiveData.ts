import fs from 'node:fs';
import { buildCsLinkDifficultyFilters } from './cslinkDifficulty';
import type { CsLinkRoomStore } from './cslinkRooms';

/** Routes always resolve the current instance; rooms can explicitly keep a snapshot. */
export function liveObject<T extends object>(current: () => T): T & { snapshot(): T } {
  return new Proxy({} as T & { snapshot(): T }, {
    get(_target, key) {
      if (key === 'snapshot') return current;
      const value = Reflect.get(current(), key);
      return typeof value === 'function' ? value.bind(current()) : value;
    },
  });
}

/** Build all selection rules before publishing them; a malformed file aborts reload. */
export function readCsLinkSelection(store: CsLinkRoomStore, files: {
  portraits?: string; active: string; popularity: string;
}) {
  const portraits = new Set<string>();
  if (files.portraits) for (const file of fs.readdirSync(files.portraits)) {
    const match = /^([1-9]\d{0,9})\.(?:png|jpe?g|webp)$/i.exec(file);
    if (match) portraits.add(`hltv:${match[1]}`);
  }
  const active = JSON.parse(fs.readFileSync(files.active, 'utf8'));
  const popular = JSON.parse(fs.readFileSync(files.popularity, 'utf8'));
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.every(id => typeof id === 'string');
  if (!validIds(active.ids) || !active.ids.length || !validIds(popular.legends) ||
      !popular.scores || typeof popular.scores !== 'object' ||
      !Object.values(popular.scores).every(score => typeof score === 'number' && Number.isFinite(score))) {
    throw new Error('CSLINK_INVALID_SELECTION_FILES');
  }
  const allowed = new Set<string>([...active.ids, ...popular.legends]);
  const endpointAllowed = (id: string) => allowed.has(id) && (!files.portraits || portraits.has(id));
  const built = buildCsLinkDifficultyFilters(store.pathGraph().ids(), endpointAllowed,
    id => popular.scores[id] ?? 0);
  if (!built.ranked.length) throw new Error('CSLINK_EMPTY_SELECTION');
  return { endpointAllowed, difficultyFilters: built.filters };
}
