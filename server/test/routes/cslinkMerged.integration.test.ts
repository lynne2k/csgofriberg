/** Synthetic map fixtures only; IDs and URLs below are not historical claims. */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import Database from 'better-sqlite3';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsLinkEvidence } from '../../src/services/cslinkEvidence';
import { CsLinkCandidates } from '../../src/services/cslinkCandidates';
import { CsLinkMerged } from '../../src/services/cslinkMerged';
import { createCsLinkMergedRoutes } from '../../src/routes/cslinkMerged';
import { errorHandler } from '../../src/middleware/common';

const oldVersion = '1234567890abcdef1234';
const oldId = (n: number) => `cs-person-${String(n).padStart(6, '0')}`;
const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = (mapId: number) => `https://www.hltv.org/stats/matches/mapstatsid/${mapId}/synthetic-fixture`;
const hltv = ['3741', '4679', '10264', '900004', '900005', '900006', '900007', '900008', '900009', '900010'];
const nick = ['NiKo', 'jks', 'niko', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf'];
let temp: string, reviewed: CsLinkEvidence, candidates: CsLinkCandidates,
  merged: CsLinkMerged, scoped: CsLinkMerged, server: http.Server, base: string;
const conflictStores: CsLinkCandidates[] = [];
const conflictVersions = new Map<string, string>();

function makeReviewed(root: string) {
  const directory = path.join(root, oldVersion); fs.mkdirSync(directory);
  const db = new Database(path.join(directory, 'staging.sqlite3'));
  db.exec(`CREATE TABLE players(player_id TEXT PRIMARY KEY, record_json TEXT);
    CREATE TABLE appearances(player_id TEXT, map_id INTEGER);
    CREATE TABLE maps(map_id INTEGER PRIMARY KEY, date_raw TEXT, review_status TEXT, record_json TEXT);
    CREATE TABLE teammate_evidence(player_a TEXT, player_b TEXT, map_id INTEGER, group_no INTEGER, source_url TEXT);`);
  hltv.forEach((numeric, index) => db.prepare('INSERT INTO players VALUES (?,?)').run(oldId(index + 1),
    JSON.stringify({ player_id: oldId(index + 1), nickname: nick[index], name: null,
      external_ids: { hltv: numeric }, evidence_urls: [`https://www.hltv.org/stats/players/${numeric}/fixture`] })));
  for (const mapId of [990001, 990002, 990004]) {
    const verified = mapId !== 990004;
    const date = `2026-01-0${mapId - 990000} 12:00:00`;
    const record = { map_id: mapId, source_url: source(mapId), record_sha256: 'a'.repeat(64),
      review_status: verified ? 'verified' : 'unreviewed',
      metadata: { date_raw: date, timezone: 'unspecified_in_source', event_raw: 'Legacy fixture',
        map_raw: 'inf', teams_display: ['Fixture A', 'Fixture B'], score: [16, 7] },
      stat_groups: [{ group_no: 1, named_team_index: 0, player_ids: [1, 2, 4, 5, 6].map(oldId) },
        { group_no: 2, named_team_index: 1, player_ids: [3, 7, 8, 9, 10].map(oldId) }],
      review: { decision: 'verify', actual_map_played: true, competition_type: 'official',
        reviewed_on: '2026-10-03', reviewed_by: 'fixture' },
      source_refs: { details: [{ file: 'fixture.csv', csv_record: mapId }] } };
    db.prepare('INSERT INTO maps VALUES (?,?,?,?)').run(mapId, date, record.review_status, JSON.stringify(record));
    db.prepare('INSERT INTO teammate_evidence VALUES (?,?,?,?,?)').run(oldId(1), oldId(2), mapId, 1, source(mapId));
    if (mapId === 990002) db.prepare('INSERT INTO teammate_evidence VALUES (?,?,?,?,?)')
      .run(oldId(1), oldId(6), mapId, 1, source(mapId));
    if (verified) for (let n = 1; n <= 10; n++) db.prepare('INSERT INTO appearances VALUES (?,?)').run(oldId(n), mapId);
  }
  db.close();
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ rights_status: 'unconfirmed' }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version: oldVersion,
    artifacts: Object.fromEntries(['staging.sqlite3', 'report.json']
      .map(name => [name, sha(path.join(directory, name))])) }));
  return directory;
}

function makeCandidate(root: string, mismatch: 'score' | 'map' | 'lineup' | null = null) {
  const directory = path.join(root, mismatch ? `candidate-${mismatch}` : 'candidate'); fs.mkdirSync(directory);
  const dbFile = path.join(directory, 'library.sqlite3');
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE players(player_id TEXT PRIMARY KEY, display_name TEXT, nicknames_json TEXT,
    player_urls_json TEXT, map_count INTEGER, review_state TEXT, eligible_for_questions INTEGER);
    CREATE TABLE maps(map_id INTEGER PRIMARY KEY, series_id INTEGER, event_name TEXT, event_url TEXT,
    event_start_date TEXT, tier TEXT, map_name TEXT, date_time_as_displayed TEXT, source_url TEXT,
    source_revision_sha256 TEXT, capture_sha256 TEXT, review_state TEXT, eligible_for_questions INTEGER);
    CREATE TABLE appearances(map_id INTEGER, player_id TEXT, team_name TEXT, nickname TEXT, player_url TEXT,
    team_score INTEGER, opponent_name TEXT, opponent_score INTEGER, PRIMARY KEY(map_id,player_id));
    CREATE TABLE edges(player_a TEXT, player_b TEXT, evidence_count INTEGER, review_state TEXT,
    eligible_for_questions INTEGER, PRIMARY KEY(player_a,player_b));
    CREATE TABLE edge_evidence(player_a TEXT, player_b TEXT, map_id INTEGER, team_name TEXT,
    PRIMARY KEY(player_a,player_b,map_id));`);
  const teams = [
    { name: 'Fixture A', score: 16, opponent: 'Fixture B', opponentScore: 7,
      players: [['3741', 'NiKo'], ['4679', 'jks'], ['12345', 'Newcomer'],
        ['900004', 'Alpha'], ['900005', 'Bravo'], ['900006', 'Charlie']] },
    { name: 'Fixture B', score: 7, opponent: 'Fixture A', opponentScore: 16,
      players: [['10264', 'niko'], ['900007', 'Delta'], ['900008', 'Echo'],
        ['900009', 'Foxtrot'], ['900010', 'Golf']] },
  ] as const;
  for (const team of teams) for (const [numeric, name] of team.players) {
    const profile = `https://www.hltv.org/stats/players/${numeric}/fixture`;
    const mapIds = numeric === '12345' ? [990003] : numeric === '900006' ? [990001] : [990001, 990003];
    db.prepare('INSERT INTO players VALUES (?,?,?,?,?,?,?)').run(numeric, name,
      JSON.stringify(name === 'jks' ? [name, 'fixtureAlias'] : [name]),
      JSON.stringify([profile]), mapIds.length, 'unreviewed', 0);
    for (const mapId of mapIds) {
      const switched = mismatch === 'lineup' && mapId === 990001 &&
        (numeric === '900006' || numeric === '900007');
      const assigned = switched ? teams.find(other => other.name !== team.name)! : team;
      const teamScore = mismatch === 'score' && mapId === 990001 && assigned.name === 'Fixture A'
        ? 15 : assigned.score;
      const opponentScore = mismatch === 'score' && mapId === 990001 && assigned.name === 'Fixture B'
        ? 15 : assigned.opponentScore;
      db.prepare('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)').run(mapId, numeric,
        assigned.name, name, profile, teamScore, assigned.opponent, opponentScore);
    }
  }
  for (const mapId of [990001, 990003]) {
    db.prepare('INSERT INTO maps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(mapId, 991000,
      'Candidate fixture', 'https://liquipedia.net/counterstrike/Synthetic', '2026-01-01',
      'S-Tier', mismatch === 'map' && mapId === 990001 ? 'Mirage' : 'Inferno',
      `2026-01-0${mapId - 990000} 12:00`, source(mapId),
      'c'.repeat(64), 'b'.repeat(64), 'unreviewed', 0);
    db.prepare('INSERT INTO edge_evidence VALUES (?,?,?,?)').run('3741', '4679', mapId, 'Fixture A');
  }
  db.prepare('INSERT INTO edge_evidence VALUES (?,?,?,?)').run('3741', '12345', 990003, 'Fixture A');
  db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run('3741', '4679', 2, 'unreviewed', 0);
  db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run('3741', '12345', 1, 'unreviewed', 0);
  db.close();
  const version = sha(dbFile).slice(0, 20);
  const inputs = { plan_sha256: '1'.repeat(64), capture_set_sha256: '2'.repeat(64),
    correction_ledger_sha256: '3'.repeat(64), plan_manifest_sha256: '4'.repeat(64), capture_count: 2 };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ schema_version: 1, version,
    library_status: 'candidate_unreviewed', review_state: 'unreviewed', eligible_for_questions: false,
    captured_valid_maps: 2, appearances: 20, distinct_player_ids: 11,
    candidate_teammate_pairs: 2, pair_map_evidence_records: 3,
    maps_with_incomplete_capture_provenance: 0, capture_provenance_gaps: [],
    plan_sha256: inputs.plan_sha256, capture_set_sha256: inputs.capture_set_sha256,
    correction_ledger_sha256: inputs.correction_ledger_sha256 }));
  const files = Object.fromEntries(['library.sqlite3', 'report.json'].map(name => {
    const file = path.join(directory, name);
    return [name, { sha256: sha(file), bytes: fs.statSync(file).size }];
  }));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, version,
    library_status: 'candidate_unreviewed', eligible_for_questions: false, files, inputs }));
  return directory;
}

async function get(url: string) {
  const response = await fetch(base + url);
  return { status: response.status, headers: response.headers, data: await response.json() };
}

function relationship(a = 'hltv:3741', b = 'hltv:4679', route = '/api/cslink/merged',
  version = merged.version, offset = 0) {
  return `${route}/relationship?playerA=${a}&playerB=${b}&version=${version}&offset=${offset}`;
}

describe('CS Link merged read-only relationship API', () => {
  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-merged-'));
    reviewed = await CsLinkEvidence.open(makeReviewed(temp));
    candidates = await CsLinkCandidates.open(makeCandidate(temp));
    merged = new CsLinkMerged(reviewed, candidates);
    scoped = new CsLinkMerged(reviewed, candidates, {
      version: 'f'.repeat(20), mapIds: new Set([990001]), approvedEventCount: 1,
      candidateMapCounts: new Map(candidates.allPlayers().map(player =>
        [player.id, player.hltvId === '12345' ? 0 : 1])),
    });
    const app = express();
    app.use('/api/cslink/merged', createCsLinkMergedRoutes(merged, true));
    app.use('/review-only', createCsLinkMergedRoutes(new CsLinkMerged(reviewed, null), true));
    app.use('/candidate-only', createCsLinkMergedRoutes(new CsLinkMerged(null, candidates), true));
    app.use('/scoped', createCsLinkMergedRoutes(scoped, true));
    for (const mismatch of ['score', 'map', 'lineup'] as const) {
      const store = await CsLinkCandidates.open(makeCandidate(temp, mismatch));
      conflictStores.push(store);
      const view = new CsLinkMerged(reviewed, store);
      conflictVersions.set(mismatch, view.version);
      app.use(`/conflict-${mismatch}`, createCsLinkMergedRoutes(view, true));
    }
    app.use('/disabled', createCsLinkMergedRoutes(merged, false));
    app.use('/unavailable', createCsLinkMergedRoutes(null, true));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    reviewed?.close(); candidates?.close();
    for (const store of conflictStores) store.close();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('counts only numeric-ID identities and exposes both source versions and availability', async () => {
    const result = await get('/api/cslink/merged/meta');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.data).toMatchObject({ version: merged.version, verifiedMaps: 2, sampledMaps: 2,
      distinctPlayers: 11, distinctPairs: 3, eligibleForQuestions: false,
      sourceAvailability: { verified: true, candidate: true },
      sourceVersions: { verified: oldVersion, candidate: candidates.version } });
    expect(result.data.example.map((player: any) => player.id)).toEqual(['hltv:3741', 'hltv:4679']);
    expect(merged.version).toMatch(/^[a-f0-9]{20}$/);
  });

  it('keeps NiKo and niko separate, deduplicates the same numeric ID, and searches source aliases', async () => {
    const result = await get('/api/cslink/merged/players?search=niko');
    expect(result.data.items.map((player: any) => player.id)).toEqual(['hltv:10264', 'hltv:3741']);
    expect(result.data.total).toBe(2);
    const niko = (await get('/api/cslink/merged/players?search=3741')).data.items[0];
    expect(niko).toMatchObject({ id: 'hltv:3741', hltvId: '3741',
      verifiedMapCount: 2, candidateMapCount: 2 });
    expect((await get('/api/cslink/merged/players?search=fixtureAlias')).data.items[0].id)
      .toBe('hltv:4679');
  });

  it('deduplicates overlapping maps, prefers verified evidence, and preserves provenance per map', async () => {
    const result = await get(relationship());
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ status: 'confirmed', total: 3,
      verifiedTotal: 2, candidateTotal: 1, hasMore: false });
    expect(result.data.verifiedTotal + result.data.candidateTotal).toBe(result.data.total);
    expect(result.data.evidence.map((proof: any) => proof.mapId)).toEqual([990003, 990002, 990001]);
    expect(result.data.evidence[0]).toMatchObject({ reviewState: 'unreviewed',
      scopeStatus: 'as_tier_pending', sourceDataset: 'hltv_candidate',
      datasetVersion: candidates.version, sourceFingerprint: 'b'.repeat(64),
      eventUrl: 'https://liquipedia.net/counterstrike/Synthetic' });
    const overlap = result.data.evidence[2];
    expect(overlap).toMatchObject({ mapId: 990001, reviewState: 'verified',
      scopeStatus: 'legacy_scope_unreviewed', sourceDataset: 'cslink_review',
      datasetVersion: oldVersion, sourceFingerprint: 'a'.repeat(64),
      recordSha256: 'a'.repeat(64), sourceUrl: source(990001),
      review: { status: 'verified', reviewedBy: 'fixture' } });
    expect(overlap.lineup.map((player: any) => player.id)).toContain('hltv:3741');
    expect(overlap.lineup.map((player: any) => player.id)).not.toContain(oldId(1));
    expect(overlap.corroboratingSources).toEqual([{ sourceDataset: 'hltv_candidate',
      datasetVersion: candidates.version, sourceUrl: source(990001),
      sourceFingerprint: 'b'.repeat(64), reviewState: 'unreviewed' }]);
    expect((await get(relationship('hltv:4679', 'hltv:3741'))).data.evidence)
      .toEqual(result.data.evidence);
    expect((await get(relationship('hltv:3741', 'hltv:4679',
      '/api/cslink/merged', merged.version, 1))).data.evidence).toHaveLength(2);
  });

  it('limits the merged inspection view to approved candidate maps without changing the source library', async () => {
    const meta = (await get('/scoped/meta')).data;
    expect(meta).toMatchObject({ sampledMaps: 1, rawSampledMaps: 2, excludedMaps: 1,
      playScopeApplied: true, approvedEvents: 1,
      candidateScope: 'local_play_approved', distinctPlayers: 10, distinctPairs: 2 });
    const proof = (await get(relationship('hltv:3741', 'hltv:4679', '/scoped', scoped.version))).data;
    expect(proof.evidence.map((item: any) => item.mapId)).toEqual([990002, 990001]);
    expect(proof.candidateTotal).toBe(0); // the included candidate map overlaps reviewed proof
    expect((await get(relationship('hltv:3741', 'hltv:12345', '/scoped', scoped.version))).status).toBe(404);
    expect((await get(relationship('hltv:3741', 'hltv:12345'))).data.candidateTotal).toBe(1);
  });

  it('does not promote candidate-only maps or infer a historical negative from no loaded proof', async () => {
    const candidateOnly = (await get(relationship('hltv:3741', 'hltv:12345'))).data;
    expect(candidateOnly).toMatchObject({ status: 'candidate_evidence', total: 1,
      verifiedTotal: 0, candidateTotal: 1 });
    expect(candidateOnly.evidence[0].reviewState).toBe('unreviewed');
    expect(candidateOnly.evidence[0].opponentLineup).toHaveLength(5);
    const reviewedOnly = (await get(relationship('hltv:3741', 'hltv:900006'))).data;
    expect(reviewedOnly).toMatchObject({ status: 'confirmed', total: 1,
      verifiedTotal: 1, candidateTotal: 0 });
    const absent = (await get(relationship('hltv:3741', 'hltv:10264'))).data;
    expect(absent).toMatchObject({ status: 'not_found_in_loaded_data', total: 0, evidence: [] });
  });

  it('rejects overlapping maps with a different score, map name, or same-team lineup', async () => {
    for (const mismatch of ['score', 'map', 'lineup'] as const) {
      const result = await get(relationship('hltv:3741', 'hltv:4679',
        `/conflict-${mismatch}`, conflictVersions.get(mismatch)!));
      expect(result.status).toBe(409);
      expect(result.data.code).toBe('CSLINK_MERGED_SOURCE_CONFLICT');
    }
  });

  it('binds each source combination to a version and degrades explicitly when one source is absent', async () => {
    const reviewMeta = (await get('/review-only/meta')).data;
    const candidateMeta = (await get('/candidate-only/meta')).data;
    expect(reviewMeta).toMatchObject({ verifiedMaps: 2, sampledMaps: 0,
      sourceAvailability: { verified: true, candidate: false } });
    expect(candidateMeta).toMatchObject({ verifiedMaps: 0, sampledMaps: 2,
      sourceAvailability: { verified: false, candidate: true } });
    expect(reviewMeta.version).not.toBe(merged.version);
    expect(candidateMeta.version).not.toBe(merged.version);
    expect((await get(relationship('hltv:3741', 'hltv:4679', '/review-only', reviewMeta.version))).data)
      .toMatchObject({ status: 'confirmed', total: 2 });
    expect((await get(relationship('hltv:3741', 'hltv:4679', '/candidate-only', candidateMeta.version))).data)
      .toMatchObject({ status: 'candidate_evidence', total: 2 });
    expect((await get(relationship('hltv:3741', 'hltv:4679', '/review-only'))).data.code)
      .toBe('CSLINK_MERGED_VERSION_CHANGED');
    expect((await get('/disabled/meta')).status).toBe(404);
    expect((await get('/unavailable/meta')).status).toBe(503);
  });

  it('requires explicit numeric IDs and rejects stale, same-player, and unknown requests', async () => {
    expect((await get(relationship('NiKo', 'hltv:4679'))).status).toBe(400);
    expect((await get(relationship('hltv:3741', 'hltv:3741'))).status).toBe(400);
    expect((await get(relationship('hltv:3741', 'hltv:999999'))).status).toBe(404);
    expect((await get(relationship('hltv:3741', 'hltv:4679',
      '/api/cslink/merged', '0'.repeat(20)))).status).toBe(409);
    expect((await get(relationship('hltv:3741', 'hltv:4679',
      '/api/cslink/merged', merged.version, -1))).status).toBe(400);
  });
});
