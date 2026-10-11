#!/usr/bin/env node
// Exercise the real local routes through the same PoW gate used by the browser.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = process.env.CSLINK_SMOKE_BASE ?? 'http://127.0.0.1:3000/api';
const userAgent = 'CSLinkLocalSmoke/1.0';
const domain = Buffer.from('csgofriberg-pow-v1\0', 'ascii');

function validDigest(challenge, nonce, difficulty) {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const first = crypto.createHash('sha256').update(domain).update(challenge).update(nonceBytes).digest();
  const mixed = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) mixed[i] = first[(i + 11) & 31] ^ first[i] ^ ((i * 29 + 0x5d) & 255);
  const digest = crypto.createHash('sha256').update(domain).update(mixed).digest();
  const bytes = Math.floor(difficulty / 8);
  for (let i = 0; i < bytes; i++) if (digest[i] !== 0) return false;
  const bits = difficulty & 7;
  return !bits || (digest[bytes] & (255 << (8 - bits))) === 0;
}

async function post(path, body) {
  return fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify(body) });
}

const challengeResponse = await post('/pow/challenge', {});
if (!challengeResponse.ok) throw new Error(`PoW challenge: ${challengeResponse.status}`);
const challenge = await challengeResponse.json();
if (challenge.algorithm !== 'csgofriberg-pow-v1' || challenge.difficulty < 16 ||
    challenge.difficulty > 24) throw new Error('Unexpected PoW challenge');
const bytes = Buffer.from(challenge.challenge, 'base64url');
let nonce = null;
for (let candidate = 0n; candidate < 10_000_000n; candidate++) {
  if (validDigest(bytes, candidate, challenge.difficulty)) {
    nonce = candidate.toString();
    break;
  }
}
if (nonce === null) throw new Error('PoW nonce not found in bounded search');
const verify = await post('/pow/verify', { id: challenge.id, nonce });
if (!verify.ok) throw new Error(`PoW verify: ${verify.status} ${await verify.text()}`);
const cookie = verify.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('PoW cookie missing');
async function get(path) {
  const response = await fetch(`${base}${path}`, { headers: { 'User-Agent': userAgent, Cookie: cookie } });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

const play = await get('/cslink/play/meta');
const merged = await get('/cslink/merged/meta');
const jks = await get('/cslink/play/players?search=jks');
const niko = await get('/cslink/merged/players?search=niko');
const relation = await get(`/cslink/merged/relationship?playerA=hltv:4679&playerB=hltv:8183&version=${merged.version}`);
const proof = relation.evidence.find(row => row.mapId === 134047);
if (!play.historicalMaps || play.historicalMaps < 3 ||
    play.historicalMaps !== merged.historicalSampledMaps ||
    !jks.items.some(row => row.id === 'hltv:4679') ||
    !niko.items.some(row => row.id === 'hltv:3741') ||
    !niko.items.some(row => row.id === 'hltv:10264') ||
    !proof || proof.sourceDataset !== 'hltv_historical_candidate' ||
    proof.sourceUrl !== 'https://www.hltv.org/stats/matches/mapstatsid/134047/liquid-vs-faze' ||
    !proof.lineup.some(row => row.id === 'hltv:4679') ||
    !proof.lineup.some(row => row.id === 'hltv:8183')) {
  throw new Error('Historical jks/rain route proof missing or inconsistent');
}
let legacyCheck = null;
const legacyGraphPath = fileURLToPath(new URL('../.local-data/cslink/legacy-relations-v1/graph.json', import.meta.url));
if (fs.existsSync(legacyGraphPath)) {
  const graph = JSON.parse(fs.readFileSync(legacyGraphPath, 'utf8'));
  if (play.legacyImportedMaps !== graph.maps.length || merged.legacyImportedMaps !== graph.maps.length) {
    throw new Error('Legacy import was not loaded by both practice and relationship routes');
  }
  const map = graph.maps.find(row => row.groups.some(group => group.some(player => player.playerId.startsWith('legacy:'))));
  if (!map) throw new Error('Expected a legacy internal-identity example');
  const group = map.groups.find(rows => rows.some(player => player.playerId.startsWith('legacy:')));
  const playerA = group.find(player => player.playerId.startsWith('legacy:'));
  const playerB = group.find(player => player.playerId !== playerA.playerId);
  const query = new URLSearchParams({ playerA: playerA.playerId, playerB: playerB.playerId, version: merged.version });
  const result = await get(`/cslink/merged/relationship?${query}`);
  const importedProof = result.evidence.find(row => row.mapId === map.mapId);
  if (!importedProof || importedProof.sourceDataset !== 'legacy_dataset' ||
      importedProof.sourceUrl !== map.sourceUrl || result.playerA.hltvId !== null) {
    throw new Error('Legacy source URL or internal identity was lost in the relationship route');
  }
  const pathQuery = new URLSearchParams({ playerA: playerA.playerId, playerB: playerB.playerId, version: play.dataVersion });
  const directPath = await get(`/cslink/play/path?${pathQuery}`);
  if (directPath.status !== 'connected' || directPath.jumps !== 1 ||
      !directPath.legs[0].proof.sourceUrl.startsWith('https://www.hltv.org/stats/matches/mapstatsid/')) {
    throw new Error('Imported teammates did not produce a one-jump playable path');
  }
  legacyCheck = { importedMaps: graph.maps.length, internalPlayerId: playerA.playerId,
    sourceUrl: importedProof.sourceUrl, jumps: directPath.jumps };
}
console.log(JSON.stringify({ historicalMaps: play.historicalMaps, sampledMaps: play.sampledMaps,
  approvedEvents: play.approvedEvents, distinctPlayers: play.distinctPlayers,
  distinctPairs: play.distinctPairs, questions: play.total,
  jksRainMap: proof.mapId, sourceUrl: proof.sourceUrl, legacyCheck }, null, 2));
