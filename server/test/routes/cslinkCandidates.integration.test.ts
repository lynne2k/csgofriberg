/** Synthetic fixtures only; no historical claim is made by this test. */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import Database from 'better-sqlite3';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CsLinkCandidates } from '../../src/services/cslinkCandidates';
import { createCsLinkCandidateRoutes } from '../../src/routes/cslinkCandidates';
import { errorHandler } from '../../src/middleware/common';

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let temp: string, store: CsLinkCandidates, server: http.Server, base: string, version: string;
const get = async (url: string) => {
  const response = await fetch(base + url);
  return { status: response.status, headers: response.headers, data: await response.json() };
};
const relationship = (a = 'hltv:3741', b = 'hltv:4679', extra = '') =>
  `/api/cslink/candidates/relationship?playerA=${a}&playerB=${b}&version=${version}${extra}`;

describe('CS Link candidate-only API', () => {
  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-candidates-'));
    const dbFile = path.join(temp, 'library.sqlite3');
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
      { name: 'Fixture A', score: 16, other: 'Fixture B', otherScore: 7,
        players: [['3741', 'NiKo'], ['4679', 'jks'], ['10001', 'Alpha'], ['10002', 'Bravo'], ['10003', 'Charlie']] },
      { name: 'Fixture B', score: 7, other: 'Fixture A', otherScore: 16,
        players: [['10264', 'niko'], ['20001', 'Delta'], ['20002', 'Echo'], ['20003', 'Foxtrot'], ['20004', 'Golf']] },
    ] as const;
    for (const team of teams) for (const [id, name] of team.players) {
      const url = `https://www.hltv.org/stats/players/${id}/fixture`;
      db.prepare('INSERT INTO players VALUES (?,?,?,?,?,?,?)').run(id, name,
        JSON.stringify(id === '4679' ? [name, 'fixtureAlias'] : [name]),
        JSON.stringify([url]), 1, 'unreviewed', 0);
      db.prepare('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)').run(990001, id, team.name, name,
        url, team.score, team.other, team.otherScore);
    }
    db.prepare('INSERT INTO maps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(990001, 900001, 'Synthetic event',
      'https://liquipedia.net/counterstrike/Synthetic', '2026-01-01', 'S-Tier', 'Inferno',
      '2026-01-01 12:00', 'https://www.hltv.org/stats/matches/mapstatsid/990001/fixture',
      'b'.repeat(64), 'a'.repeat(64), 'unreviewed', 0);
    db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run('3741', '4679', 1, 'unreviewed', 0);
    db.prepare('INSERT INTO edge_evidence VALUES (?,?,?,?)').run('3741', '4679', 990001, 'Fixture A');
    db.close();
    version = sha256(dbFile).slice(0, 20);
    const reportFile = path.join(temp, 'report.json');
    const inputs = { plan_sha256: '1'.repeat(64), capture_set_sha256: '2'.repeat(64),
      correction_ledger_sha256: '3'.repeat(64), plan_manifest_sha256: '4'.repeat(64), capture_count: 1 };
    fs.writeFileSync(reportFile, JSON.stringify({ schema_version: 1, version, library_status: 'candidate_unreviewed',
      review_state: 'unreviewed', eligible_for_questions: false, captured_valid_maps: 1,
      distinct_player_ids: 10, candidate_teammate_pairs: 1, pair_map_evidence_records: 1,
      appearances: 10, maps_with_incomplete_capture_provenance: 0, capture_provenance_gaps: [],
      plan_sha256: inputs.plan_sha256, capture_set_sha256: inputs.capture_set_sha256,
      correction_ledger_sha256: inputs.correction_ledger_sha256 }));
    const files = Object.fromEntries(['library.sqlite3', 'report.json'].map(name => {
      const file = path.join(temp, name);
      return [name, { sha256: sha256(file), bytes: fs.statSync(file).size }];
    }));
    fs.writeFileSync(path.join(temp, 'manifest.json'), JSON.stringify({ schema_version: 1, version,
      library_status: 'candidate_unreviewed', eligible_for_questions: false, files, inputs }));
    store = await CsLinkCandidates.open(temp);
    const app = express();
    app.use('/api/cslink/candidates', createCsLinkCandidateRoutes(store, true));
    app.use('/disabled', createCsLinkCandidateRoutes(store, false));
    app.use('/unavailable', createCsLinkCandidateRoutes(null, true));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    store?.close();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('identifies NiKo and niko by separate HLTV IDs', async () => {
    const result = await get('/api/cslink/candidates/players?search=niko');
    expect(result.status).toBe(200);
    expect(result.data.items.map((row: any) => [row.id, row.nickname])).toEqual([
      ['hltv:10264', 'niko'], ['hltv:3741', 'NiKo'],
    ]);
    expect((await get('/api/cslink/candidates/players?search=3741')).data.items[0].id).toBe('hltv:3741');
    expect((await get('/api/cslink/candidates/players?search=fixtureAlias')).data.items[0].id).toBe('hltv:4679');
  });

  it('returns only sampled same-team map proof and marks it unreviewed', async () => {
    const result = await get(relationship());
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.data).toMatchObject({ version, coverage: 'sampled', status: 'candidate_evidence', total: 1 });
    expect(result.data.evidence[0]).toMatchObject({ mapId: 990001, event: 'Synthetic event', tier: 'S-Tier',
      team: 'Fixture A', opponents: ['Fixture A', 'Fixture B'], score: [16, 7], reviewState: 'unreviewed',
      captureSha256: 'a'.repeat(64), sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/990001/fixture' });
    expect(result.data.evidence[0].lineup.map((row: any) => row.id)).toEqual(expect.arrayContaining(['hltv:3741', 'hltv:4679']));
    expect(result.data.evidence[0].lineup).toHaveLength(5);
    expect(result.data.evidence[0].opponentLineup).toHaveLength(5);
    expect(result.data.evidence[0].opponentLineup.map((row: any) => row.id)).toContain('hltv:10264');
  });

  it('does not convert a missing sampled edge into a negative historical claim', async () => {
    const result = await get(relationship('hltv:10264', 'hltv:4679'));
    expect(result.data).toMatchObject({ status: 'not_found_in_sample', coverage: 'sampled', total: 0, evidence: [] });
    expect((await get(relationship('hltv:4679', 'hltv:3741'))).data.evidence)
      .toEqual((await get(relationship())).data.evidence);
  });

  it('rejects wrong versions, malformed IDs and unavailable or disabled preview routes', async () => {
    expect((await get(relationship('hltv:3741', 'hltv:3741'))).status).toBe(400);
    expect((await get(relationship('hltv:3741', 'hltv:99999'))).status).toBe(404);
    expect((await get(relationship('NiKo', 'hltv:4679'))).status).toBe(400);
    expect((await get(relationship().replace(version, '0'.repeat(20)))).status).toBe(409);
    expect((await get('/disabled/meta')).status).toBe(404);
    expect((await get('/unavailable/meta')).status).toBe(503);
    expect((await get('/api/cslink/candidates/meta')).data).toMatchObject({
      mode: 'candidate_review', coverage: 'sampled', capturedMaps: 1, distinctPlayers: 10,
      candidatePairs: 1, reviewState: 'unreviewed', eligibleForQuestions: false,
    });
  });

  it('refuses a changed report file even when the database is intact', async () => {
    const file = path.join(temp, 'report.json');
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, ' ');
      await expect(CsLinkCandidates.open(temp)).rejects.toThrow('CSLINK_CANDIDATE_CHECKSUM_MISMATCH');
    } finally { fs.writeFileSync(file, original); }
  });
});
