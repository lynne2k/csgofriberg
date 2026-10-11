/** Synthetic maps only; this test does not assert any real Counter-Strike roster. */
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
import { CsLinkEvidence } from '../../src/services/cslinkEvidence';
import { CsLinkPlay } from '../../src/services/cslinkPlay';
import { CsLinkMerged } from '../../src/services/cslinkMerged';
import { createCsLinkPlayRoutes } from '../../src/routes/cslinkPlay';
import { errorHandler } from '../../src/middleware/common';
import { CsLinkLegacy } from '../../src/services/cslinkLegacy';
import { createCsLinkMergedRoutes } from '../../src/routes/cslinkMerged';
import { legacyFixtureGraph, legacyFixtureId, writeLegacyFixture } from '../fixtures/cslinkLegacy';

const digest = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const fileSha = (file: string) => digest(fs.readFileSync(file));
const eventUrl = 'https://liquipedia.net/counterstrike/Synthetic_Event';
const niko = 'hltv:3741', littleNiko = 'hltv:10264', jks = 'hltv:4679';
const names: Record<string, string> = { 3741: 'NiKo', 10264: 'niko', 4679: 'jks' };
const mapTeams = [
  { mapId: 990001, first: ['3741', '4679', '10001', '10002', '10003'],
    second: ['20001', '20002', '20003', '20004', '20005'] },
  { mapId: 990002, first: ['10264', '4679', '10004', '10005', '10006'],
    second: ['20001', '20002', '20003', '20004', '20005'] },
  { mapId: 990003, first: ['3741', '10264', '10007', '10008', '10009'],
    second: ['20001', '20002', '20003', '20004', '20005'] },
];
let temp: string, candidateDir: string, projectionDir: string, candidate: CsLinkCandidates;
let play: CsLinkPlay, server: http.Server, base: string;

const get = async (url: string) => {
  const response = await fetch(base + url);
  return { status: response.status, headers: response.headers, data: await response.json() };
};
const post = async (path: string, body: object) => {
  const response = await fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

describe('CS Link batch-approved local play graph', () => {
  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-play-'));
    candidateDir = path.join(temp, 'candidate'); projectionDir = path.join(temp, 'projection');
    fs.mkdirSync(candidateDir); fs.mkdirSync(projectionDir);
    const dbFile = path.join(candidateDir, 'library.sqlite3');
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE players(player_id TEXT PRIMARY KEY, display_name TEXT, nicknames_json TEXT,
      player_urls_json TEXT, map_count INTEGER, review_state TEXT, eligible_for_questions INTEGER);
      CREATE TABLE maps(map_id INTEGER PRIMARY KEY, event_name TEXT, event_as_displayed TEXT, event_url TEXT,
      tier TEXT, map_name TEXT, date_time_as_displayed TEXT, source_url TEXT,
      capture_sha256 TEXT, review_state TEXT, eligible_for_questions INTEGER);
      CREATE TABLE appearances(map_id INTEGER, player_id TEXT, team_name TEXT, nickname TEXT,
      player_url TEXT, team_score INTEGER, opponent_name TEXT, opponent_score INTEGER,
      PRIMARY KEY(map_id,player_id));
      CREATE TABLE edges(player_a TEXT, player_b TEXT, evidence_count INTEGER,
      review_state TEXT, eligible_for_questions INTEGER, PRIMARY KEY(player_a,player_b));
      CREATE TABLE edge_evidence(player_a TEXT, player_b TEXT, map_id INTEGER, team_name TEXT,
      PRIMARY KEY(player_a,player_b,map_id));`);
    const playerMaps = new Map<string, Set<number>>();
    const pairMaps = new Map<string, { a: string; b: string; mapIds: number[]; team: string }>();
    for (const { mapId, first, second } of mapTeams) {
      const url = `https://www.hltv.org/stats/matches/mapstatsid/${mapId}/synthetic`;
      db.prepare('INSERT INTO maps VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(mapId, 'Synthetic event', 'Synthetic event', eventUrl,
        'S-Tier', 'Inferno', '2026-01-01 12:00', url, 'a'.repeat(64), 'unreviewed', 0);
      for (const [team, players, opponent, ownScore, opponentScore] of [
        ['Fixture A', first, 'Fixture B', 16, 10], ['Fixture B', second, 'Fixture A', 10, 16],
      ] as const) {
        for (const id of players) {
          if (!playerMaps.has(id)) playerMaps.set(id, new Set());
          playerMaps.get(id)!.add(mapId);
          db.prepare('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)').run(mapId, id, team,
            names[id] ?? `Fixture-${id}`, `https://www.hltv.org/stats/players/${id}/fixture`,
            ownScore, opponent, opponentScore);
        }
        for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
          const [a, b] = [players[i], players[j]].sort((x, y) => Number(x) - Number(y));
          const key = `${a}|${b}`;
          const pair = pairMaps.get(key) ?? { a, b, mapIds: [], team };
          pair.mapIds.push(mapId); pairMaps.set(key, pair);
        }
      }
    }
    for (const [id, maps] of playerMaps) db.prepare('INSERT INTO players VALUES (?,?,?,?,?,?,?)').run(id,
      names[id] ?? `Fixture-${id}`, JSON.stringify([names[id] ?? `Fixture-${id}`]),
      JSON.stringify([`https://www.hltv.org/stats/players/${id}/fixture`]), maps.size, 'unreviewed', 0);
    for (const pair of pairMaps.values()) {
      db.prepare('INSERT INTO edges VALUES (?,?,?,?,?)').run(pair.a, pair.b,
        pair.mapIds.length, 'unreviewed', 0);
      for (const mapId of pair.mapIds) db.prepare('INSERT INTO edge_evidence VALUES (?,?,?,?)')
        .run(pair.a, pair.b, mapId, pair.team);
    }
    db.close();
    const candidateVersion = fileSha(dbFile).slice(0, 20);
    const inputs = { plan_sha256: '1'.repeat(64), capture_set_sha256: '2'.repeat(64),
      correction_ledger_sha256: '3'.repeat(64), plan_manifest_sha256: '4'.repeat(64), capture_count: 3 };
    const reportFile = path.join(candidateDir, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify({ schema_version: 1, version: candidateVersion,
      library_status: 'candidate_unreviewed', review_state: 'unreviewed', eligible_for_questions: false,
      captured_valid_maps: 3, appearances: 30, distinct_player_ids: playerMaps.size,
      candidate_teammate_pairs: pairMaps.size,
      pair_map_evidence_records: [...pairMaps.values()].reduce((n, pair) => n + pair.mapIds.length, 0),
      maps_with_incomplete_capture_provenance: 0, capture_provenance_gaps: [],
      plan_sha256: inputs.plan_sha256, capture_set_sha256: inputs.capture_set_sha256,
      correction_ledger_sha256: inputs.correction_ledger_sha256 }));
    const files = Object.fromEntries(['library.sqlite3', 'report.json'].map(name => [name, {
      sha256: fileSha(path.join(candidateDir, name)), bytes: fs.statSync(path.join(candidateDir, name)).size }]));
    const candidateManifestFile = path.join(candidateDir, 'manifest.json');
    fs.writeFileSync(candidateManifestFile, JSON.stringify({ schema_version: 1, version: candidateVersion,
      library_status: 'candidate_unreviewed', eligible_for_questions: false, files, inputs }));
    candidate = await CsLinkCandidates.open(candidateDir);
    const approval = { kind: 'user_batch_scope_approval', play_scope: 'local',
      individual_map_review: 'not_performed', evidence_state: 'observed_unreviewed' };
    const included_map_ids = [990001, 990002], approved_event_urls = [eventUrl];
    const projection = { schema_version: 1, candidate_version: candidateVersion,
      candidate_db_sha256: fileSha(dbFile), candidate_manifest_sha256: fileSha(candidateManifestFile),
      included_map_ids, approved_event_urls, approval };
    fs.writeFileSync(path.join(projectionDir, 'manifest.json'), JSON.stringify({ ...projection,
      version: digest(JSON.stringify(projection)).slice(0, 20), approved_event_count: 1,
      included_map_count: 2, excluded_maps: [{ map_id: 990003, reason: 'fixture_excluded',
        event_as_displayed: 'Synthetic event', planned_event_url: eventUrl,
        source_url: 'https://www.hltv.org/stats/matches/mapstatsid/990003/synthetic' }] }));
    play = await CsLinkPlay.open(projectionDir, candidateDir, candidate, null);
    const app = express(); app.use(express.json());
    app.use('/api/cslink/play', createCsLinkPlayRoutes(play, candidate, null, true));
    app.use('/disabled', createCsLinkPlayRoutes(play, candidate, null, false));
    app.use('/unavailable', createCsLinkPlayRoutes(null, candidate, null, true));
    app.use(errorHandler);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    candidate?.close();
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  });

  it('uses the two allowed maps, keeps case-distinct numeric identities and omits excluded proof', async () => {
    const meta = await get('/api/cslink/play/meta');
    expect(meta.status).toBe(200); expect(meta.headers.get('cache-control')).toBe('no-store');
    expect(meta.data).toMatchObject({ sampledMaps: 2, approvedEvents: 1,
      approval: { kind: 'user_batch_scope_approval', individualMapReview: 'not_performed' } });
    const search = await get('/api/cslink/play/players?search=niko');
    expect(search.data.items.map((p: any) => p.id)).toEqual([littleNiko, niko]);
    const route = await get(`/api/cslink/play/path?playerA=${niko}&playerB=${littleNiko}&version=${meta.data.dataVersion}`);
    expect(route.data).toMatchObject({ status: 'connected', jumps: 2 });
    expect(route.data.players.map((p: any) => p.id)).toEqual([niko, jks, littleNiko]);
    expect(route.data.legs.every((leg: any) => leg.proof.reviewState === 'unreviewed' &&
      leg.proof.scopeApproval === 'user_batch_scope_approval' &&
      [990001, 990002].includes(leg.proof.mapId))).toBe(true);
  });

  it('keeps complete common-neighbor answers server-side until answer or reveal', async () => {
    const meta = (await get('/api/cslink/play/meta')).data;
    const rules = { minAnswers: 1, maxAnswers: 3, excludeEndpoints: true,
      acceptAllCommonNeighbors: true, coverage: 'approved_as_tier_sample' };
    const id = digest(JSON.stringify([meta.dataVersion, rules, niko, littleNiko])).slice(0, 20);
    const fixed = await get(`/api/cslink/play/question/${id}?bankVersion=${meta.bankVersion}`);
    expect(fixed.status).toBe(200);
    expect(fixed.data).toMatchObject({ id, playerA: { id: niko }, playerB: { id: littleNiko } });
    expect(fixed.data).not.toHaveProperty('answers');
    const body = { questionId: id, bankVersion: meta.bankVersion };
    const reveal = await post('/api/cslink/play/reveal', body);
    expect(reveal.data.answers.map((answer: any) => answer.player.id)).toEqual([jks]);
    for (const side of ['left', 'right']) {
      const proof = reveal.data.answers[0][side].proof;
      expect(proof.sourceUrl).toMatch(/^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\//);
      expect(proof.lineup).toHaveLength(5);
      expect(proof.opponentLineup).toHaveLength(5);
      expect(proof.sourceFingerprint).toBe('a'.repeat(64));
      expect(proof.reviewState).toBe('unreviewed');
    }
    expect((await post('/api/cslink/play/answer', { ...body, playerId: jks })).data.status).toBe('accepted');
    expect((await post('/api/cslink/play/answer', { ...body, playerId: niko })).data.status).toBe('endpoint');
    expect((await post('/api/cslink/play/answer', { ...body, playerId: 'hltv:10007' })).data.status).toBe('not_confirmed');
  });

  it('matches the exhaustive two-hop reference bank and preserves its version ordering', () => {
    const graph = new Map<string, Set<string>>();
    for (const map of mapTeams.slice(0, 2)) for (const team of [map.first, map.second]) {
      for (const raw of team) {
        const id = `hltv:${raw}`;
        const neighbors = graph.get(id) ?? new Set<string>();
        for (const other of team) if (other !== raw) neighbors.add(`hltv:${other}`);
        graph.set(id, neighbors);
      }
    }
    const ids = [...graph.keys()].sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
    const rules = { minAnswers: 1, maxAnswers: 3, excludeEndpoints: true,
      acceptAllCommonNeighbors: true, coverage: 'approved_as_tier_sample' };
    const all: { id: string; answers: string[]; direct: boolean }[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const answers = [...graph.get(a)!].filter(id => id !== b && graph.get(b)!.has(id))
        .sort((x, y) => Number(x.slice(5)) - Number(y.slice(5)));
      if (answers.length < 1 || answers.length > 3) continue;
      all.push({ id: digest(JSON.stringify([play.dataVersion, rules, a, b])).slice(0, 20),
        answers, direct: graph.get(a)!.has(b) });
    }
    const expectedBankVersion = digest(JSON.stringify({ dataVersion: play.dataVersion, rules,
      questions: all.map(question => [question.id, question.answers]) })).slice(0, 20);
    expect(play.metadata()).toMatchObject({ bankVersion: expectedBankVersion,
      total: all.length, bridge: all.filter(question => !question.direct).length,
      multiple: all.filter(question => question.answers.length > 1).length });
  });

  it('binds versions, refuses changed source files, and isolates unavailable routes', async () => {
    const meta = (await get('/api/cslink/play/meta')).data;
    expect((await get(`/api/cslink/play/question?pool=bridge&previous=${'0'.repeat(20)}`)).status).toBe(200);
    expect((await get(`/api/cslink/play/question?pool=wrong`)).status).toBe(400);
    expect((await get(`/api/cslink/play/path?playerA=${niko}&playerB=${littleNiko}&version=${'0'.repeat(20)}`)).status).toBe(409);
    expect((await get(`/api/cslink/play/question/${'0'.repeat(20)}?bankVersion=${meta.bankVersion}`)).status).toBe(404);
    expect((await get('/disabled/meta')).status).toBe(404);
    expect((await get('/unavailable/meta')).status).toBe(503);
    const file = path.join(candidateDir, 'manifest.json');
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, ' ');
      await expect(CsLinkPlay.open(projectionDir, candidateDir, candidate, null))
        .rejects.toThrow('CSLINK_PLAY_INVALID_PROJECTION');
    } finally { fs.writeFileSync(file, original); }
  });


  it('plays legacy-only identities, keeps duplicate match evidence, and lets actual captures override a legacy map', async () => {
    const input = legacyFixtureGraph();
    // An old row assigning a new identity to an already captured map must not add false edges.
    input.maps.push({ ...structuredClone(input.maps[0]), mapId: 990001,
      sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/990001/synthetic' });
    input.maps.push(structuredClone(input.maps[0]));
    const legacy = CsLinkLegacy.open(writeLegacyFixture(temp, input))!;
    const combined = await CsLinkPlay.open(projectionDir, candidateDir, candidate, null, null, legacy);
    const pathGraph = combined.pathGraph();
    expect(combined.pathGraph()).toBe(pathGraph);
    expect(pathGraph.dataVersion).toBe(combined.dataVersion);
    expect(pathGraph.shortestJumps(niko, littleNiko)).toBe(2);
    expect(combined.getPathPlayer(niko)).toMatchObject({ id: niko, nickname: 'NiKo' });
    expect(combined.getPathPlayer(littleNiko)).toMatchObject({ id: littleNiko, nickname: 'niko' });
    expect(combined.getPathPlayer(legacyFixtureId)).toMatchObject({ id: legacyFixtureId, hltvId: null });
    expect(combined.getPathPlayer('hltv:10007')).toBeNull(); // excluded map only
    expect(combined.getPathPlayer('invented')).toBeNull();
    const resolved = combined.getPathPlayer(niko)!;
    resolved.nickname = 'must not mutate pinned store';
    expect(combined.getPathPlayer(niko)?.nickname).toBe('NiKo');
    const round = { roundId: 'mixed-sources', dataVersion: combined.dataVersion,
      startId: littleNiko, endId: legacyFixtureId,
      serverStartedAtMs: 1_000, serverDeadlineAtMs: 10_000, maxJumps: 8 };
    const connected = pathGraph.finish(round, [littleNiko, jks, legacyFixtureId], 4_000);
    expect(connected).toMatchObject({ valid: true, finish: { jumps: 2, elapsedMs: 3_000,
      hops: [{ evidence: { mapId: 990002, recordSha256: 'a'.repeat(64) } },
        { evidence: { mapId: 990102, recordSha256: 'f'.repeat(64), evidenceCount: 2 } }] } });
    expect(pathGraph.finish({ ...round, dataVersion: 'different-store' },
      [littleNiko, jks, legacyFixtureId], 4_000)).toEqual({ valid: false, reason: 'version_changed' });
    expect(combined.metadata()).toMatchObject({ sampledMaps: 4, legacyImportedMaps: 2,
      legacyInternalPlayers: 1 });
    expect(combined.search('oldJksAlias', candidate, null).items.map(player => player.id)).toEqual([jks]);
    const one = combined.shortestPath(niko, legacyFixtureId, combined.dataVersion);
    expect(one).toMatchObject({ jumps: 1, legs: [{ evidenceCount: 2, proof: { mapId: 990102,
      sourceDataset: 'legacy_dataset' } }] });
    const two = combined.shortestPath(littleNiko, legacyFixtureId, combined.dataVersion);
    expect(two.jumps).toBe(2);
    expect(two.players.map(player => player.id)).toEqual([littleNiko, jks, legacyFixtureId]);
    const merged = new CsLinkMerged(null, candidate, combined.candidateScope(), null, legacy);
    expect(merged.relationship(niko, legacyFixtureId, merged.version, 0).total).toBe(2);
    expect(merged.relationship(niko, jks, merged.version, 0).evidence.map(proof => proof.sourceDataset))
      .toEqual(['legacy_dataset', 'legacy_dataset', 'hltv_candidate']);
    expect(merged.metadata()).toMatchObject({ sampledMaps: 4, legacyImportedMaps: 2,
      distinctPairs: combined.metadata().distinctPairs });
    const app = express(); app.use(express.json());
    app.use('/play', createCsLinkPlayRoutes(combined, candidate, null, true));
    app.use('/merged', createCsLinkMergedRoutes(merged, true));
    app.use(errorHandler);
    const localServer = http.createServer(app);
    await new Promise<void>(resolve => localServer.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
    try {
      const pathResponse = await fetch(`${localUrl}/play/path?playerA=${niko}&playerB=${legacyFixtureId}&version=${combined.dataVersion}`);
      expect(pathResponse.status).toBe(200);
      const relation = await fetch(`${localUrl}/merged/relationship?playerA=${niko}&playerB=${legacyFixtureId}&version=${merged.version}`);
      expect(relation.status).toBe(200);
      const rules = { minAnswers: 1, maxAnswers: 3, excludeEndpoints: true,
        acceptAllCommonNeighbors: true, coverage: 'approved_as_tier_sample' };
      const questionId = digest(JSON.stringify([combined.dataVersion, rules, niko, 'hltv:40001'])).slice(0, 20);
      const answer = await fetch(`${localUrl}/play/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, bankVersion: combined.bankVersion, playerId: legacyFixtureId }) });
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ status: 'accepted', player: {
        id: legacyFixtureId, hltvId: null, profileUrl: null } });
    } finally { await new Promise<void>(resolve => localServer.close(() => resolve())); }
  });


  it('keeps every exact same-name identity selectable and supports event-context search in both views', async () => {
    const input = legacyFixtureGraph();
    const template = structuredClone(input.maps[0]);
    input.maps = [];
    const exactIds: string[] = [];
    for (let i = 0; i < 53; i++) {
      const id = `legacy:${i.toString(16).padStart(20, '0')}`;
      const nickname = i < 28 ? i % 2 ? 'sameName' : 'SameName' : `sameName-extra-${i}`;
      if (i < 28) exactIds.push(id);
      input.players.push({ ...input.players[2], id, nickname,
        identityContext: i === 27 ? 'Marseille 2018 / lineup 1' : `Synthetic event ${i}` });
      const map = structuredClone(template);
      map.mapId = 991000 + i;
      map.sourceUrl = `https://www.hltv.org/stats/matches/mapstatsid/${map.mapId}/synthetic`;
      map.groups[0][2] = { playerId: id, nickname, identityBasis: 'context_only' };
      input.maps.push(map);
    }
    const legacy = CsLinkLegacy.open(writeLegacyFixture(temp, input))!;
    const combined = await CsLinkPlay.open(projectionDir, candidateDir, candidate, null, null, legacy);
    const merged = new CsLinkMerged(null, candidate, combined.candidateScope(), null, legacy);
    for (const search of [
      (query: string) => combined.search(query, candidate, null),
      (query: string) => merged.search(query),
    ]) {
      const result = search('sAmEnAmE');
      expect(result.total).toBe(53);
      expect(result.items.filter(player => player.nickname.toLowerCase() === 'samename')
        .map(player => player.id).sort()).toEqual([...exactIds].sort());
      expect(result.items.filter(player => player.nickname.toLowerCase() !== 'samename')).toHaveLength(20);
      expect(search('same').items).toHaveLength(20);
      expect(search('sameName Marseille').items.map(player => player.id)).toEqual([exactIds[27]]);
      expect(search('Marseille sameName').items.map(player => player.id)).toEqual([exactIds[27]]);
      expect(search('sameName absent-event').items).toHaveLength(0);
    }
  });

  it('adds only historically scoped maps by numeric ID, keeps sources distinct, and checks the report hash', async () => {
    const historyDir = path.join(temp, 'history-projection');
    fs.mkdirSync(historyDir);
    const approval = { kind: 'user_requested_legacy_import', play_scope: 'local',
      individual_map_review: 'not_performed', evidence_state: 'observed_unreviewed' };
    const included_map_ids = [990003], approved_event_urls = [eventUrl];
    const input = { schema_version: 1, candidate_version: candidate.version,
      candidate_db_sha256: fileSha(path.join(candidateDir, 'library.sqlite3')),
      candidate_manifest_sha256: fileSha(path.join(candidateDir, 'manifest.json')),
      included_map_ids, approved_event_urls, approval };
    const version = digest(JSON.stringify(input)).slice(0, 20);
    const reportFile = path.join(historyDir, 'report.json');
    fs.writeFileSync(reportFile, JSON.stringify({ schema_version: 1, version,
      candidate_version: candidate.version, status: 'user_requested_legacy_import_local_play_only',
      approved_event_count: 1, included_map_count: 1, excluded_map_count: 2, sampled_map_count: 3,
      individual_map_review: 'not_performed', map_review_state: 'observed_unreviewed',
      eligible_for_local_play: true, eligible_for_public_release: false }));
    fs.writeFileSync(path.join(historyDir, 'manifest.json'), JSON.stringify({ ...input, version,
      approved_event_count: 1, included_map_count: 1,
      excluded_maps: [990001, 990002].map(map_id => ({ map_id, reason: 'outside_history_fixture',
        event_as_displayed: 'Synthetic event', planned_event_url: eventUrl,
        source_url: `https://www.hltv.org/stats/matches/mapstatsid/${map_id}/synthetic` })),
      files: { 'report.json': { bytes: fs.statSync(reportFile).size, sha256: fileSha(reportFile) } } }));
    const historical = await CsLinkPlay.open(projectionDir, candidateDir, candidate, null,
      { projectionDir: historyDir, candidateDir, candidates: candidate });
    expect(historical.dataVersion).not.toBe(play.dataVersion);
    expect(historical.metadata()).toMatchObject({ sampledMaps: 3, historicalMaps: 1,
      sourceVersions: { historical: candidate.version } });
    expect(historical.search('niko', candidate, null).items.map(player => player.id))
      .toEqual([littleNiko, niko]);
    const result = historical.shortestPath(niko, littleNiko, historical.dataVersion);
    expect(result).toMatchObject({ status: 'connected', jumps: 1 });
    expect(result.legs[0].proof).toMatchObject({ mapId: 990003,
      sourceDataset: 'hltv_historical_candidate', scopeApproval: 'user_requested_legacy_import' });
    const merged = new CsLinkMerged(null, candidate, historical.candidateScope(), historical.historicalScope());
    const proof = merged.relationship(niko, littleNiko, merged.version, 0);
    expect(proof).toMatchObject({ status: 'candidate_evidence', total: 1 });
    expect(proof.evidence[0]).toMatchObject({ mapId: 990003,
      sourceDataset: 'hltv_historical_candidate', scopeStatus: 'historical_as_tier_local' });
    const historicalOnly = new CsLinkMerged(null, null, null, historical.historicalScope());
    expect(historicalOnly.search('niko').items.map(player => player.id)).toEqual([littleNiko, niko]);
    expect(historicalOnly.relationship(niko, littleNiko, historicalOnly.version, 0).total).toBe(1);

    // The same pair can have an older sampled map and a distinct verified map.
    // The displayed path should favor the reviewed proof while retaining both maps.
    const reviewedLineup = mapTeams[2].first.map(id => ({ id: `review:${id}`,
      nickname: names[id] ?? `Fixture-${id}`, hltvId: id,
      profileUrl: `https://www.hltv.org/stats/players/${id}/fixture`,
      name: null, verifiedMapCount: 1 }));
    const reviewed = {
      version: 'e'.repeat(20),
      allPlayers: () => reviewedLineup,
      verifiedPairs: () => [{ player_a: 'review:3741', player_b: 'review:10264' }],
      relationship: () => ({ total: 1, evidence: [{ mapId: 990004, event: 'Synthetic event',
        map: 'Inferno', dateRaw: '2026-01-02 12:00', team: 'Fixture A',
        opponents: ['Fixture A', 'Fixture B'], score: [16, 10],
        sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/990004/synthetic',
        lineup: reviewedLineup, recordSha256: 'b'.repeat(64) }] }),
    } as unknown as CsLinkEvidence;
    const withReviewed = await CsLinkPlay.open(projectionDir, candidateDir, candidate, reviewed,
      { projectionDir: historyDir, candidateDir, candidates: candidate });
    expect(withReviewed.shortestPath(niko, littleNiko, withReviewed.dataVersion).legs[0].proof)
      .toMatchObject({ mapId: 990004, reviewState: 'verified', sourceDataset: 'cslink_review' });
    const mergedWithReviewed = new CsLinkMerged(reviewed, candidate,
      withReviewed.candidateScope(), withReviewed.historicalScope());
    expect(mergedWithReviewed.relationship(niko, littleNiko, mergedWithReviewed.version, 0)
      .evidence.map(item => item.mapId)).toEqual([990004, 990003]);

    const original = fs.readFileSync(reportFile);
    try {
      fs.appendFileSync(reportFile, ' ');
      await expect(CsLinkPlay.open(projectionDir, candidateDir, candidate, null,
        { projectionDir: historyDir, candidateDir, candidates: candidate }))
        .rejects.toThrow('CSLINK_PLAY_REPORT_CHECKSUM_MISMATCH');
    } finally { fs.writeFileSync(reportFile, original); }
  });
});
