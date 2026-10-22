import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { HttpError } from '../middleware/common';
import { cslinkFuzzyIncludes } from './cslinkLegacy';

export interface EvidencePlayer {
  id: string;
  nickname: string;
  name: string | null;
  hltvId: string;
  profileUrl: string;
  verifiedMapCount: number;
}

interface MapRecord {
  map_id: number;
  source_url: string;
  record_sha256: string;
  review_status: string;
  metadata: { date_raw: string; timezone: string; event_raw: string; map_raw: string; teams_display: string[]; score: number[] };
  stat_groups: { group_no: number; named_team_index: number; player_ids?: string[] }[];
  review: { decision: string; actual_map_played: boolean; competition_type: string; reviewed_on: string; reviewed_by: string };
  source_refs: Record<string, { file: string; csv_record: number }[]>;
}

const MAP_NAMES: Record<string, string> = {
  anc: 'Ancient', anb: 'Anubis', cbl: 'Cobblestone', cch: 'Cache', d2: 'Dust2',
  inf: 'Inferno', mrg: 'Mirage', nuke: 'Nuke', ovp: 'Overpass', trn: 'Train', vtg: 'Vertigo',
};

async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** A pinned, read-only review dataset, separate from the game's player database. */
export class CsLinkEvidence {
  private players = new Map<string, EvidencePlayer>();
  private constructor(private db: Database.Database, readonly version: string, readonly rightsStatus: string) {
    const counts = new Map((db.prepare(`SELECT player_id, count(DISTINCT map_id) AS count
      FROM appearances WHERE player_id IS NOT NULL GROUP BY player_id`).all() as { player_id: string; count: number }[])
      .map(row => [row.player_id, row.count]));
    for (const row of db.prepare('SELECT record_json FROM players ORDER BY player_id').all() as { record_json: string }[]) {
      const person = JSON.parse(row.record_json);
      const hid = String(person.external_ids?.hltv ?? '');
      if (!/^\d+$/.test(hid)) throw new Error('CSLINK_INVALID_PLAYER_IDENTITY');
      const profile = (person.evidence_urls as string[]).find(url =>
        new RegExp(`^https://www\\.hltv\\.org/(?:stats/players|player)/${hid}/[^/?#\\s]+$`).test(url));
      if (!profile) throw new Error('CSLINK_MISSING_PLAYER_SOURCE');
      this.players.set(person.player_id, {
        id: person.player_id, nickname: person.nickname, name: person.name || null,
        hltvId: hid, profileUrl: profile,
        verifiedMapCount: counts.get(person.player_id) ?? 0,
      });
    }
  }

  static async open(versionDir: string): Promise<CsLinkEvidence> {
    const directory = path.resolve(versionDir);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (!/^[a-f0-9]{20}$/.test(manifest.version) || path.basename(directory) !== manifest.version) {
      throw new Error('CSLINK_INVALID_VERSION');
    }
    for (const name of ['staging.sqlite3', 'report.json']) {
      if (await sha256(path.join(directory, name)) !== manifest.artifacts?.[name]) {
        throw new Error(`CSLINK_CHECKSUM_MISMATCH: ${name}`);
      }
    }
    const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8'));
    // Loaded only when the local review feature is configured; production does not require this optional driver.
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(path.join(directory, 'staging.sqlite3'), { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      return new CsLinkEvidence(db, manifest.version, report.rights_status);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  /** Exact identity inventory for the local merged, read-only view. */
  allPlayers() { return [...this.players.values()]; }

  player(id: string) {
    const player = this.players.get(id);
    if (!player) throw new HttpError(404, 'CSLINK_PLAYER_NOT_FOUND');
    return player;
  }

  verifiedPairs() {
    return this.db.prepare(`SELECT DISTINCT e.player_a, e.player_b FROM teammate_evidence e
      JOIN maps m ON m.map_id=e.map_id WHERE m.review_status='verified'
      ORDER BY e.player_a, e.player_b`).all() as { player_a: string; player_b: string }[];
  }

  metadata() {
    const range = this.db.prepare(`SELECT count(*) AS count, min(date_raw) AS first, max(date_raw) AS last
      FROM maps WHERE review_status='verified'`).get() as { count: number; first: string | null; last: string | null };
    const a = [...this.players.values()].find(p => p.hltvId === '3741');
    const b = [...this.players.values()].find(p => p.hltvId === '4679');
    const example = a && b && this.countPair(a.id, b.id) > 0 ? [a, b] : null;
    return {
      version: this.version, mode: 'local_review' as const, coverage: 'partial' as const,
      rightsStatus: this.rightsStatus, registeredPlayers: this.players.size,
      verifiedMaps: range.count, verifiedDateRangeRaw: { first: range.first, last: range.last }, example,
    };
  }

  searchAll(query: string) {
    const raw = query.trim().normalize('NFC');
    const key = raw.toLowerCase();
    const matches = !key ? [] : [...this.players.values()].filter(p =>
      cslinkFuzzyIncludes(p.nickname, raw) || p.name?.toLowerCase().includes(key) ||
      p.hltvId === key.replace(/^hltv:/, '') || p.id === raw);
    // Ranking only: a single or exact-looking result still requires an explicit ID selection.
    matches.sort((a, b) => Number(b.nickname === raw) - Number(a.nickname === raw) || a.id.localeCompare(b.id));
    return matches;
  }

  search(query: string) {
    const matches = this.searchAll(query);
    return { version: this.version, items: matches.slice(0, 20), total: matches.length };
  }

  private countPair(a: string, b: string) {
    const [first, second] = [a, b].sort();
    return (this.db.prepare(`SELECT count(*) AS count FROM teammate_evidence e
      JOIN maps m ON m.map_id=e.map_id WHERE e.player_a=? AND e.player_b=? AND m.review_status='verified'`)
      .get(first, second) as { count: number }).count;
  }

  relationship(a: string, b: string, version: string, offset = 0) {
    if (version !== this.version) throw new HttpError(409, 'CSLINK_VERSION_CHANGED');
    const playerA = this.players.get(a), playerB = this.players.get(b);
    if (!playerA || !playerB) throw new HttpError(404, 'CSLINK_PLAYER_NOT_FOUND');
    if (a === b) throw new HttpError(400, 'CSLINK_SAME_PLAYER');
    const [first, second] = [a, b].sort();
    const total = this.countPair(a, b);
    const rows = this.db.prepare(`SELECT e.group_no, e.source_url, m.record_json FROM teammate_evidence e
      JOIN maps m ON m.map_id=e.map_id WHERE e.player_a=? AND e.player_b=? AND m.review_status='verified'
      ORDER BY m.date_raw DESC, e.map_id DESC LIMIT 50 OFFSET ?`).all(first, second, offset) as
      { group_no: number; source_url: string; record_json: string }[];
    const evidence = rows.map(row => {
      const map: MapRecord = JSON.parse(row.record_json);
      const group = map.stat_groups.find(g => g.group_no === row.group_no);
      if (!group?.player_ids?.includes(a) || !group.player_ids.includes(b) ||
          map.review.decision !== 'verify' || !map.review.actual_map_played || map.review.competition_type !== 'official' ||
          row.source_url !== map.source_url ||
          !new RegExp(`^https://www\\.hltv\\.org/stats/matches/mapstatsid/${map.map_id}/[^/?#\\s]+/?$`).test(map.source_url)) {
        throw new Error('CSLINK_INCONSISTENT_EVIDENCE');
      }
      return {
        mapId: map.map_id, event: map.metadata.event_raw, map: MAP_NAMES[map.metadata.map_raw] ?? map.metadata.map_raw,
        dateRaw: map.metadata.date_raw, timezone: map.metadata.timezone,
        team: map.metadata.teams_display[group.named_team_index], opponents: map.metadata.teams_display,
        score: map.metadata.score, sourceUrl: map.source_url,
        lineup: group.player_ids.map(id => this.players.get(id)!),
        review: { status: 'verified' as const, reviewedOn: map.review.reviewed_on, reviewedBy: map.review.reviewed_by },
        recordSha256: map.record_sha256, sourceRefs: map.source_refs,
      };
    });
    return {
      version: this.version, coverage: 'partial' as const, playerA, playerB,
      status: total ? 'confirmed' as const : 'not_found_in_reviewed_data' as const,
      total, offset, hasMore: offset + evidence.length < total, evidence,
    };
  }
}
