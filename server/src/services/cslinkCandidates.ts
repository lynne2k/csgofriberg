import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { HttpError } from '../middleware/common';

interface CandidatePlayerRow {
  player_id: string;
  display_name: string;
  nicknames_json: string;
  player_urls_json: string;
  map_count: number;
  review_state: string;
  eligible_for_questions: number;
}

export interface CandidatePlayer {
  id: string;
  hltvId: string;
  nickname: string;
  profileUrl: string;
  evidenceMapCount: number;
}

interface CandidateMapRow {
  map_id: number;
  event_name: string;
  event_url: string;
  tier: string;
  map_name: string;
  date_time_as_displayed: string;
  source_url: string;
  capture_sha256: string;
  review_state: string;
  eligible_for_questions: number;
  team_name: string;
}

interface AppearanceRow {
  player_id: string;
  team_name: string;
  nickname: string;
  player_url: string;
  team_score: number;
  opponent_name: string;
  opponent_score: number;
}

const VERSION = /^[a-f0-9]{20}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^\d+$/;

async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

function hltvId(raw: string): string {
  const id = raw.replace(/^hltv:/, '');
  if (!ID.test(id)) throw new Error('CSLINK_CANDIDATE_INVALID_IDENTITY');
  return id;
}

/** Read-only, unreviewed map appearances. This store is never passed to question or room services. */
export class CsLinkCandidates {
  private readonly players = new Map<string, CandidatePlayer>();
  private readonly aliases = new Map<string, string[]>();

  private constructor(private readonly db: Database.Database, readonly version: string,
    private readonly counts: { capturedMaps: number; distinctPlayers: number; candidatePairs: number;
      pairMapEvidenceRecords: number }) {
    const rows = db.prepare('SELECT * FROM players ORDER BY CAST(player_id AS INTEGER)').all() as CandidatePlayerRow[];
    for (const row of rows) {
      const numericId = hltvId(row.player_id);
      const urls = JSON.parse(row.player_urls_json) as unknown;
      const nicknames = JSON.parse(row.nicknames_json) as unknown;
      if (row.review_state !== 'unreviewed' || row.eligible_for_questions !== 0 ||
          !Array.isArray(urls) || !Array.isArray(nicknames) ||
          !urls.every(url => typeof url === 'string') ||
          !nicknames.every(name => typeof name === 'string') ||
          !Number.isSafeInteger(row.map_count) || row.map_count < 1) {
        throw new Error('CSLINK_CANDIDATE_INVALID_PLAYER');
      }
      const profileUrl = urls.find(url => new RegExp(`^https://www\\.hltv\\.org/(?:stats/players|player)/${numericId}/[^/?#\\s]+/?$`).test(url));
      if (typeof profileUrl !== 'string') throw new Error('CSLINK_CANDIDATE_MISSING_PLAYER_SOURCE');
      const id = `hltv:${numericId}`;
      if (this.players.has(id)) throw new Error('CSLINK_CANDIDATE_DUPLICATE_IDENTITY');
      this.players.set(id, { id, hltvId: numericId, nickname: row.display_name, profileUrl,
        evidenceMapCount: row.map_count });
      this.aliases.set(id, nicknames as string[]);
    }
    if (this.players.size !== counts.distinctPlayers ||
        (db.prepare('SELECT count(*) AS count FROM maps').get() as { count: number }).count !== counts.capturedMaps ||
        (db.prepare('SELECT count(*) AS count FROM edges').get() as { count: number }).count !== counts.candidatePairs ||
        (db.prepare('SELECT count(*) AS count FROM edge_evidence').get() as { count: number }).count !== counts.pairMapEvidenceRecords ||
        (db.prepare(`SELECT count(*) AS count FROM edges e WHERE e.evidence_count < 1 OR
          e.evidence_count <> (SELECT count(*) FROM edge_evidence ee
            WHERE ee.player_a=e.player_a AND ee.player_b=e.player_b)`).get() as { count: number }).count !== 0 ||
        (db.prepare(`SELECT count(*) AS count FROM maps WHERE review_state <> 'unreviewed' OR eligible_for_questions <> 0`)
          .get() as { count: number }).count !== 0 ||
        (db.prepare(`SELECT count(*) AS count FROM edges WHERE review_state <> 'unreviewed' OR eligible_for_questions <> 0`)
          .get() as { count: number }).count !== 0) {
      throw new Error('CSLINK_CANDIDATE_COUNT_OR_REVIEW_MISMATCH');
    }
  }

  static async open(versionDir: string): Promise<CsLinkCandidates> {
    const directory = path.resolve(versionDir);
    const manifest = JSON.parse(await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.schema_version !== 1 || manifest.library_status !== 'candidate_unreviewed' ||
        manifest.eligible_for_questions !== false ||
        !VERSION.test(manifest.version)) throw new Error('CSLINK_CANDIDATE_INVALID_MANIFEST');
    for (const name of ['library.sqlite3', 'report.json']) {
      const expected = manifest.files?.[name];
      const actual = await hashFile(path.join(directory, name));
      if (!SHA256.test(expected?.sha256) || expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) {
        throw new Error(`CSLINK_CANDIDATE_CHECKSUM_MISMATCH: ${name}`);
      }
    }
    if (manifest.version !== manifest.files['library.sqlite3'].sha256.slice(0, 20)) {
      throw new Error('CSLINK_CANDIDATE_INVALID_VERSION');
    }
    const report = JSON.parse(await fs.promises.readFile(path.join(directory, 'report.json'), 'utf8'));
    for (const name of ['plan_sha256', 'capture_set_sha256', 'correction_ledger_sha256']) {
      if (!SHA256.test(manifest.inputs?.[name]) || report[name] !== manifest.inputs[name]) {
        throw new Error(`CSLINK_CANDIDATE_INPUT_MISMATCH: ${name}`);
      }
    }
    if (!SHA256.test(manifest.inputs?.plan_manifest_sha256) ||
        manifest.inputs.capture_count !== report.captured_valid_maps ||
        report.maps_with_incomplete_capture_provenance !== 0 ||
        !Array.isArray(report.capture_provenance_gaps) || report.capture_provenance_gaps.length !== 0) {
      throw new Error('CSLINK_CANDIDATE_INCOMPLETE_PROVENANCE');
    }
    if (report.schema_version !== 1 || report.version !== manifest.version ||
        report.library_status !== 'candidate_unreviewed' || report.review_state !== 'unreviewed' ||
        report.eligible_for_questions !== false ||
        !Number.isSafeInteger(report.captured_valid_maps) || report.captured_valid_maps < 1 ||
        report.appearances !== report.captured_valid_maps * 10 ||
        !Number.isSafeInteger(report.distinct_player_ids) || report.distinct_player_ids < 1 ||
        !Number.isSafeInteger(report.candidate_teammate_pairs) || report.candidate_teammate_pairs < 0 ||
        !Number.isSafeInteger(report.pair_map_evidence_records) || report.pair_map_evidence_records < 0) {
      throw new Error('CSLINK_CANDIDATE_INVALID_REPORT');
    }
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(path.join(directory, 'library.sqlite3'), { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      return new CsLinkCandidates(db, manifest.version, {
        capturedMaps: report.captured_valid_maps, distinctPlayers: report.distinct_player_ids,
        candidatePairs: report.candidate_teammate_pairs,
        pairMapEvidenceRecords: report.pair_map_evidence_records,
      });
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  /** Exact identity inventory for the local merged, read-only view. */
  allPlayers() { return [...this.players.values()]; }

  examplePair() {
    const row = this.db.prepare(`SELECT player_a, player_b FROM edges
      ORDER BY evidence_count DESC, CAST(player_a AS INTEGER), CAST(player_b AS INTEGER) LIMIT 1`)
      .get() as { player_a: string; player_b: string } | undefined;
    return row ? [`hltv:${row.player_a}`, `hltv:${row.player_b}`] as const : null;
  }

  candidatePairs() {
    return this.db.prepare('SELECT player_a, player_b FROM edges ORDER BY player_a, player_b')
      .all() as { player_a: string; player_b: string }[];
  }

  metadata() {
    return { version: this.version, mode: 'candidate_review' as const, coverage: 'sampled' as const,
      capturedMaps: this.counts.capturedMaps, distinctPlayers: this.counts.distinctPlayers,
      candidatePairs: this.counts.candidatePairs,
      pairMapEvidenceRecords: this.counts.pairMapEvidenceRecords,
      reviewState: 'unreviewed' as const, eligibleForQuestions: false as const };
  }

  searchAll(query: string) {
    const raw = query.trim().normalize('NFC');
    const key = raw.toLocaleLowerCase();
    const items = !key ? [] : [...this.players.values()].filter(player =>
      player.nickname.normalize('NFC').toLocaleLowerCase().includes(key) ||
      this.aliases.get(player.id)?.some(alias => alias.normalize('NFC').toLocaleLowerCase().includes(key)) ||
      player.hltvId === raw.replace(/^hltv:/, '') || player.id === raw);
    items.sort((a, b) => Number(b.nickname === raw) - Number(a.nickname === raw) ||
      b.evidenceMapCount - a.evidenceMapCount || Number(a.hltvId) - Number(b.hltvId));
    return items;
  }

  search(query: string) {
    const items = this.searchAll(query);
    return { version: this.version, items: items.slice(0, 20), total: items.length };
  }

  relationship(a: string, b: string, version: string, offset: number) {
    if (version !== this.version) throw new HttpError(409, 'CSLINK_CANDIDATE_VERSION_CHANGED');
    const playerA = this.players.get(a), playerB = this.players.get(b);
    if (!playerA || !playerB) throw new HttpError(404, 'CSLINK_CANDIDATE_PLAYER_NOT_FOUND');
    if (a === b) throw new HttpError(400, 'CSLINK_CANDIDATE_SAME_PLAYER');
    const [first, second] = [playerA.hltvId, playerB.hltvId].sort((x, y) => Number(x) - Number(y));
    const pair = this.db.prepare('SELECT evidence_count FROM edges WHERE player_a=? AND player_b=?')
      .get(first, second) as { evidence_count: number } | undefined;
    const total = pair?.evidence_count ?? 0;
    const rows = this.db.prepare(`SELECT m.*, ee.team_name FROM edge_evidence ee
      JOIN maps m ON m.map_id=ee.map_id WHERE ee.player_a=? AND ee.player_b=?
      ORDER BY m.date_time_as_displayed DESC, m.map_id DESC LIMIT 50 OFFSET ?`)
      .all(first, second, offset) as CandidateMapRow[];
    const appearanceStatement = this.db.prepare('SELECT * FROM appearances WHERE map_id=? ORDER BY player_id');
    const evidence = rows.map(map => {
      const appearances = appearanceStatement.all(map.map_id) as AppearanceRow[];
      const sameTeam = appearances.filter(row => row.team_name === map.team_name);
      const opponentName = sameTeam[0]?.opponent_name;
      const opponentTeam = appearances.filter(row => row.team_name === opponentName);
      if (map.review_state !== 'unreviewed' || map.eligible_for_questions !== 0 ||
          appearances.length !== 10 || sameTeam.length !== 5 || opponentTeam.length !== 5 ||
          !sameTeam.some(row => row.player_id === first) ||
          !sameTeam.some(row => row.player_id === second) ||
          !sameTeam.every(row => row.opponent_name === opponentName &&
            row.team_score === sameTeam[0].team_score && row.opponent_score === sameTeam[0].opponent_score) ||
          !opponentTeam.every(row => row.opponent_name === map.team_name &&
            row.team_score === sameTeam[0].opponent_score && row.opponent_score === sameTeam[0].team_score) ||
          !SHA256.test(map.capture_sha256) ||
          !new RegExp(`^https://www\\.hltv\\.org/stats/matches/mapstatsid/${map.map_id}/[^/?#\\s]+/?$`).test(map.source_url)) {
        throw new Error('CSLINK_CANDIDATE_INCONSISTENT_EVIDENCE');
      }
      const teamRow = sameTeam[0];
      const mapPlayer = (row: AppearanceRow) => {
        const player = this.players.get(`hltv:${row.player_id}`);
        if (!player || !new RegExp(`^https://www\\.hltv\\.org/(?:stats/players|player)/${row.player_id}/[^/?#\\s]+/?$`).test(row.player_url)) {
          throw new Error('CSLINK_CANDIDATE_INCONSISTENT_LINEUP');
        }
        return { ...player, nickname: row.nickname, profileUrl: row.player_url };
      };
      const lineup = sameTeam.map(mapPlayer);
      const opponentLineup = opponentTeam.map(mapPlayer);
      return { mapId: map.map_id, event: map.event_name, eventUrl: map.event_url, tier: map.tier,
        map: map.map_name, dateRaw: map.date_time_as_displayed, team: map.team_name,
        opponents: [map.team_name, teamRow.opponent_name], score: [teamRow.team_score, teamRow.opponent_score],
        sourceUrl: map.source_url, lineup, opponentLineup, reviewState: 'unreviewed' as const,
        captureSha256: map.capture_sha256 };
    });
    return { version: this.version, coverage: 'sampled' as const, playerA, playerB,
      status: total ? 'candidate_evidence' as const : 'not_found_in_sample' as const,
      total, offset, hasMore: offset + evidence.length < total, evidence };
  }
}
