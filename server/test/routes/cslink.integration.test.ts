/** Synthetic datasets only: none of these fixture maps are production evidence. */
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
import { createCsLinkRoutes } from '../../src/routes/cslink';
import { errorHandler } from '../../src/middleware/common';

const version = '1234567890abcdef1234';
const id = (n: number) => `cs-person-${String(n).padStart(6, '0')}`;
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let directory: string, temp: string, store: CsLinkEvidence, server: http.Server, base: string;

async function get(url: string) {
  const response = await fetch(base + url);
  return { status: response.status, headers: response.headers, data: await response.json() };
}
const pair = (a = id(1), b = id(3), extra = '') =>
  `/api/cslink/relationship?playerA=${a}&playerB=${b}&version=${version}${extra}`;

describe('CS Link read-only evidence API', () => {
  beforeAll(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cslink-evidence-'));
    directory = path.join(temp, version); fs.mkdirSync(directory);
    const db = new Database(path.join(directory, 'staging.sqlite3'));
    db.exec(`CREATE TABLE players(player_id TEXT PRIMARY KEY, record_json TEXT);
      CREATE TABLE appearances(player_id TEXT, map_id INTEGER);
      CREATE TABLE maps(map_id INTEGER PRIMARY KEY, date_raw TEXT, review_status TEXT, record_json TEXT);
      CREATE TABLE teammate_evidence(player_a TEXT, player_b TEXT, map_id INTEGER, group_no INTEGER, source_url TEXT);`);
    for (let n = 1; n <= 10; n++) {
      const nickname = ({ 1: 'NiKo', 2: 'niko', 3: 'jks' } as Record<number, string>)[n] ?? `Fixture-${n}`;
      const hid = ({ 1: '3741', 2: '10264', 3: '4679' } as Record<number, string>)[n] ?? String(9000000 + n);
      db.prepare('INSERT INTO players VALUES (?,?)').run(id(n), JSON.stringify({
        player_id: id(n), nickname, name: n === 1 ? 'Nikola Kovač' : n === 2 ? 'Nikolaj Kristensen' : null,
        external_ids: { hltv: hid }, evidence_urls: [`https://www.hltv.org/stats/players/${hid}/fixture`],
      }));
    }
    for (let n = 0; n < 55; n++) {
      const mid = 990001 + n;
      const status = n < 52 ? 'verified' : ['unreviewed', 'excluded', 'deferred'][n - 52];
      const url = `https://www.hltv.org/stats/matches/mapstatsid/${mid}/synthetic-fixture`;
      const record = {
        map_id: mid, source_url: url, record_sha256: 'a'.repeat(64), review_status: status,
        metadata: { date_raw: '2020-01-01 12:00:00', timezone: 'unspecified_in_source', event_raw: 'Synthetic fixture',
          map_raw: 'inf', teams_display: ['Fixture A', 'Fixture B'], score: [16, 10] },
        stat_groups: [{ group_no: 1, named_team_index: 0, player_ids: [1, 3, 4, 5, 6].map(id) },
          { group_no: 2, named_team_index: 1, player_ids: [2, 7, 8, 9, 10].map(id) }],
        review: { decision: 'verify', actual_map_played: true, competition_type: 'official', reviewed_on: '2026-10-03', reviewed_by: 'assistant' },
        source_refs: { details: [{ file: 'fixture.csv', csv_record: n + 2 }] },
      };
      db.prepare('INSERT INTO maps VALUES (?,?,?,?)').run(mid, record.metadata.date_raw, status, JSON.stringify(record));
      db.prepare('INSERT INTO teammate_evidence VALUES (?,?,?,?,?)').run(id(1), id(3), mid, 1, url);
      // A unique contaminating edge must not enter questions from unapproved maps.
      if (status !== 'verified') db.prepare('INSERT INTO teammate_evidence VALUES (?,?,?,?,?)').run(id(2), id(3), mid, 1, url);
      if (n === 0) {
        const roster = [1, 3, 4, 5, 6];
        for (let i = 0; i < roster.length; i++) for (let j = i + 1; j < roster.length; j++) {
          if (roster[i] === 1 && roster[j] === 3) continue;
          db.prepare('INSERT INTO teammate_evidence VALUES (?,?,?,?,?)').run(id(roster[i]), id(roster[j]), mid, 1, url);
        }
      }
      if (status === 'verified') for (let p = 1; p <= 10; p++) db.prepare('INSERT INTO appearances VALUES (?,?)').run(id(p), mid);
    }
    db.close();
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ rights_status: 'unconfirmed' }));
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ version,
      artifacts: Object.fromEntries(['staging.sqlite3', 'report.json'].map(name => [name, hash(path.join(directory, name))])) }));
    store = await CsLinkEvidence.open(directory);
    const app = express();
    app.use(express.json());
    app.use('/api/cslink', createCsLinkRoutes(store, true));
    app.use('/disabled', createCsLinkRoutes(store, false));
    app.use('/unavailable', createCsLinkRoutes(null, true));
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

  it('searches case-insensitively but preserves both distinct identities', async () => {
    const { data } = await get('/api/cslink/players?search=niko');
    expect(data.items.map((p: any) => [p.id, p.nickname, p.hltvId])).toEqual([
      [id(2), 'niko', '10264'], [id(1), 'NiKo', '3741'],
    ]);
    expect((await get('/api/cslink/players?search=3741')).data.items[0].id).toBe(id(1));
    expect((await get('/api/cslink/players?search=%25')).data.items).toEqual([]);
  });
  it('returns the exact map source, team, lineup, review, and fingerprint', async () => {
    const { data, status, headers } = await get(pair());
    expect(status).toBe(200); expect(headers.get('cache-control')).toBe('no-store');
    expect(data.status).toBe('confirmed'); expect(data.version).toBe(version);
    expect(data.evidence[0]).toMatchObject({ mapId: 990052, event: 'Synthetic fixture', map: 'Inferno',
      team: 'Fixture A', sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/990052/synthetic-fixture',
      recordSha256: 'a'.repeat(64), timezone: 'unspecified_in_source', review: { status: 'verified' } });
    expect(data.evidence[0].lineup.map((p: any) => p.id)).toContain(id(1));
    expect(data.evidence[0].lineup.map((p: any) => p.id)).not.toContain(id(2));
  });
  it('is symmetric and paginates all evidence without unreviewed/excluded/deferred maps', async () => {
    const forward = (await get(pair())).data;
    const backward = (await get(pair(id(3), id(1)))).data;
    expect(backward.evidence).toEqual(forward.evidence);
    expect(forward.total).toBe(52); expect(forward.evidence).toHaveLength(50); expect(forward.hasMore).toBe(true);
    const tail = (await get(pair(id(1), id(3), '&offset=50'))).data;
    expect(tail.evidence).toHaveLength(2); expect(tail.hasMore).toBe(false);
    expect(new Set([...forward.evidence, ...tail.evidence].map((e: any) => e.mapId)).size).toBe(52);
  });
  it('does not treat an opponent or absent evidence as a proven negative relationship', async () => {
    const { data } = await get(pair(id(2), id(3)));
    expect(data.status).toBe('not_found_in_reviewed_data'); expect(data.coverage).toBe('partial');
    expect(data.evidence).toEqual([]);
  });
  it('rejects same identity, unknown IDs, malformed query and mixed versions', async () => {
    expect((await get(pair(id(1), id(1)))).status).toBe(400);
    expect((await get(pair(id(1), id(999)))).status).toBe(404);
    expect((await get(pair('NiKo', id(3)))).status).toBe(400);
    expect((await get(pair(id(1), id(3), '&offset=-1'))).status).toBe(400);
    expect((await get(pair().replace(version, '0'.repeat(20)))).data.code).toBe('CSLINK_VERSION_CHANGED');
  });
  it('reports only verified coverage and handles disabled or absent datasets explicitly', async () => {
    expect((await get('/api/cslink/meta')).data).toMatchObject({ verifiedMaps: 52, registeredPlayers: 10, coverage: 'partial', rightsStatus: 'unconfirmed' });
    expect((await get('/disabled/meta')).status).toBe(404);
    expect((await get('/unavailable/meta')).status).toBe(503);
  });
  it('detects changed source artifacts and leaves the dataset unchanged during queries', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    expect(hash(path.join(directory, 'staging.sqlite3'))).toBe(manifest.artifacts['staging.sqlite3']);
    const file = path.join(directory, 'report.json'), original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, ' ');
      await expect(CsLinkEvidence.open(directory)).rejects.toThrow('CSLINK_CHECKSUM_MISMATCH');
    } finally { fs.writeFileSync(file, original); }
  });

  it('serves prompts without answers, then accepts every common teammate with two valid proof legs', async () => {
    const meta = (await get('/api/cslink/practice/meta')).data;
    expect(meta).toMatchObject({ total: 10, bridge: 0, multiple: 10, releaseReady: false, coverage: 'partial' });
    expect((await get('/api/cslink/practice/question?pool=bridge')).status).toBe(404);
    const q = (await get('/api/cslink/practice/question?pool=multiple')).data;
    expect(q).not.toHaveProperty('answers'); expect(q).not.toHaveProperty('answerIds');
    const fixed = await get(`/api/cslink/practice/question/${q.id}?bankVersion=${q.bankVersion}`);
    expect(fixed.status).toBe(200);
    expect(fixed.data).toEqual(q);
    expect(fixed.data).not.toHaveProperty('answers');
    expect((await get(`/api/cslink/practice/question/${q.id}?bankVersion=${'0'.repeat(20)}`)).status).toBe(409);
    expect((await get(`/api/cslink/practice/question/${'0'.repeat(20)}?bankVersion=${q.bankVersion}`)).status).toBe(404);
    const submit = async (operation: string, extra = {}) => {
      const res = await fetch(base + '/api/cslink/practice/' + operation, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: q.id, bankVersion: q.bankVersion, ...extra }) });
      return { status: res.status, data: await res.json() };
    };
    const { data: reveal } = await submit('reveal');
    expect(reveal.answers).toHaveLength(3);
    expect(new Set(reveal.answers.map((a: any) => a.player.id)).size).toBe(3);
    for (const answer of reveal.answers) {
      const checked = await submit('answer', { playerId: answer.player.id });
      expect(checked.data.status).toBe('accepted');
      for (const [side, endpoint] of [['left', q.playerA.id], ['right', q.playerB.id]]) {
        expect(checked.data.explanation[side].proof.lineup.map((p: any) => p.id)).toEqual(expect.arrayContaining([endpoint, answer.player.id]));
        expect(checked.data.explanation[side].proof.sourceUrl).toMatch(/^https:\/\/www.hltv.org\/stats\/matches\/mapstatsid\//);
      }
    }
    expect((await submit('answer', { playerId: q.playerA.id })).data.status).toBe('endpoint');
    expect((await submit('answer', { playerId: id(2) })).data).toMatchObject({ status: 'not_confirmed', explanation: null });
    expect((await submit('answer', { playerId: 'NiKo' })).status).toBe(400);
    expect((await submit('answer', { playerId: id(999) })).status).toBe(404);
    expect((await submit('reveal', { bankVersion: '0'.repeat(20) })).status).toBe(409);
    expect((await submit('reveal', { questionId: '0'.repeat(20) })).status).toBe(404);
    expect((await get(`/api/cslink/practice/question?pool=all&previous=${q.id}`)).data.id).not.toBe(q.id);
  });
});
