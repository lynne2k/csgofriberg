import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { HttpError } from '../middleware/common';
import { CsLinkCandidates } from './cslinkCandidates';
import { CsLinkEvidence } from './cslinkEvidence';
import { CsLinkPathGraph } from './cslinkPaths';
import { CsLinkLegacy, CSLINK_PLAYER_ID, compareCsLinkPlayerIds, cslinkPairKey, cslinkSearchResults } from './cslinkLegacy';

const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^[a-f0-9]{20}$/;
const PLAYER_ID = CSLINK_PLAYER_ID;
const MAP_URL = /^https:\/\/www\.hltv\.org\/stats\/matches\/mapstatsid\/(\d+)\/[^/?#\s]+\/?$/;
const EVENT_URL = /^https:\/\/liquipedia\.net\/counterstrike\/[^\s?#]+$/;
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digestBuffer = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pairKey = cslinkPairKey;

interface ProjectionManifest {
  schema_version: number;
  version: string;
  candidate_version: string;
  candidate_db_sha256: string;
  candidate_manifest_sha256: string;
  included_map_ids: number[];
  approved_event_urls: string[];
  excluded_maps: { map_id: number; reason: string; event_as_displayed: string;
    planned_event_url: string; source_url: string }[];
  approved_event_count?: number;
  included_map_count?: number;
  approval_source_sha256?: string;
  files?: Record<string, { bytes: number; sha256: string }>;
  approval: { kind: string; play_scope: string; individual_map_review: string; evidence_state: string };
}

interface MapRow {
  map_id: number; event_name: string; event_as_displayed: string; event_url: string; tier: string; map_name: string;
  date_time_as_displayed: string; source_url: string; capture_sha256: string;
  review_state: string; eligible_for_questions: number;
}

interface AppearanceRow {
  map_id: number; player_id: string; team_name: string; nickname: string; player_url: string;
  team_score: number; opponent_name: string; opponent_score: number;
}

export interface PlayPlayer {
  id: string; hltvId: string | null; nickname: string; profileUrl: string | null;
  identityKind?: 'hltv' | 'legacy_context'; identityContext?: string; legacyMapCount?: number;
  name?: string | null; verifiedMapCount: number; candidateMapCount: number;
}

interface PlayProof {
  mapId: number; event: string; eventUrl?: string; tier?: string; map: string; dateRaw: string;
  team: string; opponents: string[]; score: number[]; sourceUrl: string;
  lineup: PlayPlayer[]; opponentLineup?: PlayPlayer[];
  reviewState: 'verified' | 'unreviewed'; sourceFingerprint: string;
  sourceDataset: 'cslink_review' | 'hltv_candidate' | 'hltv_historical_candidate' | 'legacy_dataset';
  scopeStatus?: 'legacy_as_import';
  scopeApproval: 'legacy' | 'user_batch_scope_approval' | 'user_requested_legacy_import';
}

interface Edge { a: string; b: string; byMap: Map<number, PlayProof>; proof: PlayProof }
interface Question { id: string; a: string; b: string; answerIds: string[]; direct: boolean }
export type PlayPool = 'bridge' | 'multiple' | 'all';

/** Enumerate only pairs sharing a neighbor, in the old numeric pair order. */
export function buildCsLinkQuestionBank(graph: ReadonlyMap<string, ReadonlySet<string>>,
  dataVersion: string) {
  const rules = { minAnswers: 1, maxAnswers: 3, excludeEndpoints: true,
    acceptAllCommonNeighbors: true, coverage: 'approved_as_tier_sample' };
  const answersByPair = new Map<string, Set<string>>();
  for (const [center, neighborSet] of graph) {
    const neighbors = [...neighborSet].sort(compareCsLinkPlayerIds);
    for (let i = 0; i < neighbors.length; i++) for (let j = i + 1; j < neighbors.length; j++) {
      const key = pairKey(neighbors[i], neighbors[j]);
      let answers = answersByPair.get(key);
      if (!answers) { answers = new Set(); answersByPair.set(key, answers); }
      if (answers.size <= rules.maxAnswers) answers.add(center);
    }
  }
  const keys = [...answersByPair.keys()].sort((left, right) => {
    const [la, lb] = left.split('|'), [ra, rb] = right.split('|');
    return compareCsLinkPlayerIds(la, ra) || compareCsLinkPlayerIds(lb, rb);
  });
  const questions: Question[] = [];
  for (const key of keys) {
    const [a, b] = key.split('|');
    const common = [...answersByPair.get(key)!];
    if (common.length < rules.minAnswers || common.length > rules.maxAnswers) continue;
    common.sort(compareCsLinkPlayerIds);
    questions.push({ id: hash([dataVersion, rules, a, b]).slice(0, 20),
      a, b, answerIds: common, direct: graph.get(a)?.has(b) ?? false });
  }
  const bankVersion = hash({ dataVersion, rules,
    questions: questions.map(q => [q.id, q.answerIds]) }).slice(0, 20);
  return { questions, bankVersion };
}

export interface HistoricalPlayInput {
  projectionDir: string;
  candidateDir: string;
  candidates: CsLinkCandidates;
}

interface ValidatedSource {
  manifest: ProjectionManifest;
  db: Database.Database;
  candidates: CsLinkCandidates;
  dataset: 'hltv_candidate' | 'hltv_historical_candidate';
  approval: 'user_batch_scope_approval' | 'user_requested_legacy_import';
}

/** A separate local game graph. Its source map records retain their own review state. */
export class CsLinkPlay {
  readonly dataVersion: string;
  readonly bankVersion: string;
  private readonly players = new Map<string, PlayPlayer>();
  private readonly currentCandidateMapCounts = new Map<string, number>();
  private readonly historicalCandidateMapCounts = new Map<string, number>();
  private readonly reviewedIds = new Map<string, string>();
  private readonly edges = new Map<string, Edge>();
  private readonly graph = new Map<string, Set<string>>();
  private readonly questions = new Map<string, Question>();
  private readonly pools: Record<PlayPool, Question[]> = { bridge: [], multiple: [], all: [] };
  private readonly sampledMaps: number;
  private readonly approvedEvents: number;
  private readonly currentApprovedEvents: number;
  private readonly historicalApprovedEvents: number;
  private readonly includedMapIds: ReadonlySet<number>;
  private readonly candidateVersion: string;
  private readonly reviewedVersion: string | null;
  private readonly historicalVersion: string | null;
  private readonly historicalProjectionVersion: string | null;
  private readonly historicalMapIds: ReadonlySet<number>;
  private readonly historicalCandidates: CsLinkCandidates | null;
  private readonly legacy: CsLinkLegacy | null;
  private readonly pathGraphSnapshot: CsLinkPathGraph;

  private constructor(current: ValidatedSource, reviewed: CsLinkEvidence | null,
    historical: ValidatedSource | null, legacy: CsLinkLegacy | null) {
    const { manifest, candidates } = current;
    this.candidateVersion = candidates.version;
    this.reviewedVersion = reviewed?.version ?? null;
    this.historicalVersion = historical?.candidates.version ?? null;
    this.historicalProjectionVersion = historical?.manifest.version ?? null;
    this.historicalCandidates = historical?.candidates ?? null;
    this.historicalMapIds = new Set(historical?.manifest.included_map_ids ?? []);
    this.currentApprovedEvents = manifest.approved_event_urls.length;
    this.historicalApprovedEvents = historical?.manifest.approved_event_urls.length ?? 0;
    this.includedMapIds = new Set(manifest.included_map_ids);
    this.dataVersion = hash({ schema: 'cslink-local-play-v1', projection: manifest.version,
      candidate: candidates.version, reviewed: reviewed?.version ?? null,
      ...(historical ? { historical: { projection: historical.manifest.version,
        candidate: historical.candidates.version } } : {}),
      ...(legacy ? { legacy: legacy.version } : {}) }).slice(0, 20);

    for (const source of reviewed?.allPlayers() ?? []) {
      const id = `hltv:${source.hltvId}`;
      if (!PLAYER_ID.test(id) || this.players.has(id)) throw new Error('CSLINK_PLAY_INVALID_REVIEWED_IDENTITY');
      this.reviewedIds.set(source.id, id);
      this.players.set(id, { id, hltvId: source.hltvId, nickname: source.nickname,
        name: source.name, profileUrl: source.profileUrl,
        verifiedMapCount: source.verifiedMapCount, candidateMapCount: 0 });
    }
    const addCandidatePlayers = (sourceStore: CsLinkCandidates, isHistorical: boolean) =>
      sourceStore.allPlayers().forEach(source => {
        if (!PLAYER_ID.test(source.id) || source.id !== `hltv:${source.hltvId}`) {
          throw new Error('CSLINK_PLAY_INVALID_CANDIDATE_IDENTITY');
        }
        const previous = this.players.get(source.id);
        this.players.set(source.id, { id: source.id, hltvId: source.hltvId,
          nickname: isHistorical && previous ? previous.nickname : source.nickname,
          name: previous?.name ?? null,
          profileUrl: isHistorical && previous ? previous.profileUrl : source.profileUrl,
          verifiedMapCount: previous?.verifiedMapCount ?? 0, candidateMapCount: 0 });
      });
    addCandidatePlayers(candidates, false);
    if (historical) addCandidatePlayers(historical.candidates, true);

    const mapSignatures = new Map<number, string>();
    const candidateMapsByPlayer = new Map<string, Set<number>>();
    const loadSource = ({ manifest: scope, db, dataset, approval }: ValidatedSource,
      mapCounts: Map<string, number>) => {

      const allowed = new Set(scope.included_map_ids);
      const mapRows = db.prepare('SELECT * FROM maps ORDER BY map_id').all() as MapRow[];
      const mapIds = new Set(mapRows.map(map => map.map_id));
      const excluded = new Map(scope.excluded_maps.map(map => [map.map_id, map]));
      if (mapIds.size !== mapRows.length ||
          mapRows.some(map => !allowed.has(map.map_id) && !excluded.has(map.map_id)) ||
          [...allowed].some(id => !mapIds.has(id) || excluded.has(id)) ||
          [...excluded].some(([id, entry]) => !mapIds.has(id) ||
            entry.event_as_displayed !== mapRows.find(map => map.map_id === id)?.event_as_displayed ||
            entry.planned_event_url !== mapRows.find(map => map.map_id === id)?.event_url ||
            entry.source_url !== mapRows.find(map => map.map_id === id)?.source_url) ||
          scope.approved_event_urls.length !== new Set(mapRows.filter(map => allowed.has(map.map_id))
            .map(map => map.event_url)).size ||
          mapRows.some(map => allowed.has(map.map_id) && !scope.approved_event_urls.includes(map.event_url))) {
        throw new Error('CSLINK_PLAY_SCOPE_MISMATCH');
      }
      const appearanceStmt = db.prepare('SELECT * FROM appearances WHERE map_id=? ORDER BY CAST(player_id AS INTEGER)');
      for (const map of mapRows) {
        if (!allowed.has(map.map_id)) continue;
        const sourceMatch = MAP_URL.exec(map.source_url);
        if (map.review_state !== 'unreviewed' || map.eligible_for_questions !== 0 ||
            !SHA.test(map.capture_sha256) || !sourceMatch || Number(sourceMatch[1]) !== map.map_id ||
            !EVENT_URL.test(map.event_url) || !/^[AS]-Tier$/.test(map.tier)) {
          throw new Error('CSLINK_PLAY_INVALID_MAP');
        }
        const appearances = appearanceStmt.all(map.map_id) as AppearanceRow[];
        const teams = [...new Set(appearances.map(row => row.team_name))];
        if (appearances.length !== 10 || teams.length !== 2 || new Set(appearances.map(row => row.player_id)).size !== 10) {
          throw new Error('CSLINK_PLAY_INVALID_LINEUP');
        }
        const signature = JSON.stringify({ map: map.map_name.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, ''),
          teams: teams.map(team => ({ team, players: appearances.filter(row => row.team_name === team)
            .map(row => row.player_id).sort((a, b) => Number(a) - Number(b)),
          score: appearances.find(row => row.team_name === team)?.team_score })).sort((a, b) =>
            a.team.localeCompare(b.team)) });
        const previousSignature = mapSignatures.get(map.map_id);
        if (previousSignature && previousSignature !== signature) {
          throw new Error('CSLINK_PLAY_OVERLAP_CONFLICT');
        }
        mapSignatures.set(map.map_id, signature);
        for (const team of teams) {
          const ownRows = appearances.filter(row => row.team_name === team);
          const opponentRows = appearances.filter(row => row.team_name !== team);
          const head = ownRows[0], opposite = opponentRows[0];
          if (ownRows.length !== 5 || opponentRows.length !== 5 ||
              ownRows.some(row => row.opponent_name !== opposite.team_name ||
                row.team_score !== head.team_score || row.opponent_score !== head.opponent_score) ||
              opponentRows.some(row => row.opponent_name !== team ||
                row.team_score !== opposite.team_score || row.opponent_score !== opposite.opponent_score) ||
              head.team_score !== opposite.opponent_score || head.opponent_score !== opposite.team_score) {
            throw new Error('CSLINK_PLAY_INVALID_LINEUP');
          }
          const playerFor = (row: AppearanceRow) => {
            const player = this.players.get(`hltv:${row.player_id}`);
            if (!player || !new RegExp(`^https://www\\.hltv\\.org/(?:stats/players|player)/${row.player_id}/[^/?#\\s]+/?$`).test(row.player_url)) {
              throw new Error('CSLINK_PLAY_INVALID_PLAYER_SOURCE');
            }
            return { ...player, nickname: row.nickname, profileUrl: row.player_url };
          };
          const lineup = ownRows.map(playerFor), opponentLineup = opponentRows.map(playerFor);
          for (const player of lineup) {
            mapCounts.set(player.id, (mapCounts.get(player.id) ?? 0) + 1);
            const maps = candidateMapsByPlayer.get(player.id) ?? new Set<number>();
            maps.add(map.map_id);
            candidateMapsByPlayer.set(player.id, maps);
            this.players.get(player.id)!.candidateMapCount = maps.size;
          }
          const proof: PlayProof = { mapId: map.map_id, event: map.event_name,
            eventUrl: map.event_url, tier: map.tier, map: map.map_name,
            dateRaw: map.date_time_as_displayed, team,
            opponents: [team, opposite.team_name], score: [head.team_score, head.opponent_score],
            sourceUrl: map.source_url, lineup, opponentLineup, reviewState: 'unreviewed',
            sourceFingerprint: map.capture_sha256, sourceDataset: dataset,
            scopeApproval: approval };
          for (let i = 0; i < lineup.length; i++) for (let j = i + 1; j < lineup.length; j++) {
            this.addEdge(lineup[i].id, lineup[j].id, proof);
          }
        }
      }
    };
    if (historical) loadSource(historical, this.historicalCandidateMapCounts);
    loadSource(current, this.currentCandidateMapCounts);

    const occupiedMapIds = new Set(mapSignatures.keys());
    if (reviewed) for (const pair of reviewed.verifiedPairs()) {
      const a = this.reviewedIds.get(pair.player_a), b = this.reviewedIds.get(pair.player_b);
      if (!a || !b) throw new Error('CSLINK_PLAY_UNRESOLVED_REVIEWED_IDENTITY');
      let offset = 0;
      while (true) {
        const relation = reviewed.relationship(pair.player_a, pair.player_b, reviewed.version, offset);
        for (const source of relation.evidence) {
          occupiedMapIds.add(source.mapId);
          const lineup = source.lineup.map(p => this.players.get(`hltv:${p.hltvId}`)!);
          if (lineup.length !== 5 || lineup.some(p => !p) ||
              !lineup.some(p => p.id === a) || !lineup.some(p => p.id === b) ||
              !SHA.test(source.recordSha256) || !MAP_URL.test(source.sourceUrl)) {
            throw new Error('CSLINK_PLAY_INVALID_REVIEWED_PROOF');
          }
          const proof: PlayProof = { mapId: source.mapId, event: source.event, map: source.map,
            dateRaw: source.dateRaw, team: source.team, opponents: source.opponents,
            score: source.score, sourceUrl: source.sourceUrl, lineup,
            reviewState: 'verified', sourceFingerprint: source.recordSha256,
            sourceDataset: 'cslink_review', scopeApproval: 'legacy' };
          this.addEdge(a, b, proof);
        }
        offset += relation.evidence.length;
        if (offset >= relation.total) break;
        if (!relation.evidence.length) throw new Error('CSLINK_PLAY_REVIEWED_PAGINATION_STALLED');
      }
    }

    // Actual captures/reviewed maps take precedence over inferred legacy identities.
    this.legacy = legacy?.excludingMaps(occupiedMapIds) ?? null;
    for (const player of this.legacy?.allPlayers() ?? []) {
      const existing = this.players.get(player.id);
      this.players.set(player.id, existing ? { ...existing, legacyMapCount: player.legacyMapCount,
        identityKind: 'hltv' } : player);
    }
    for (const [a, b] of this.legacy?.pairs() ?? []) {
      for (const proof of this.legacy!.relationship(a, b)) this.addEdge(a, b, proof);
    }
    this.sampledMaps = new Set([...manifest.included_map_ids,
      ...(historical?.manifest.included_map_ids ?? []),
      ...(this.legacy?.maps.map(map => map.mapId) ?? [])]).size;
    this.approvedEvents = new Set([...manifest.approved_event_urls,
      ...(historical?.manifest.approved_event_urls ?? []),
      ...(this.legacy?.maps.map(map => map.eventUrl) ?? [])]).size;

    for (const edge of this.edges.values()) {
      edge.proof = [...edge.byMap.values()].sort((a, b) =>
        Number(b.reviewState === 'verified') - Number(a.reviewState === 'verified') || b.mapId - a.mapId)[0];
      for (const [a, b] of [[edge.a, edge.b], [edge.b, edge.a]]) {
        if (!this.graph.has(a)) this.graph.set(a, new Set());
        this.graph.get(a)!.add(b);
      }
    }
    this.pathGraphSnapshot = new CsLinkPathGraph(this.dataVersion, [...this.edges.values()].map(edge => ({
      a: edge.a, b: edge.b, proof: edge.proof, evidenceCount: edge.byMap.size,
    })));
    const bank = buildCsLinkQuestionBank(this.graph, this.dataVersion);
    for (const q of bank.questions) {
      this.questions.set(q.id, q);
      this.pools.all.push(q);
      if (!q.direct) this.pools.bridge.push(q);
      if (q.answerIds.length > 1) this.pools.multiple.push(q);
    }
    this.bankVersion = bank.bankVersion;
  }

  private static validateProjection(projectionDir: string, candidateDir: string,
    candidates: CsLinkCandidates, approvalKind: ValidatedSource['approval']): ProjectionManifest {
    const projection = JSON.parse(fs.readFileSync(path.join(path.resolve(projectionDir), 'manifest.json'), 'utf8')) as ProjectionManifest;
    const candidateManifestFile = path.join(path.resolve(candidateDir), 'manifest.json');
    const candidateDbFile = path.join(path.resolve(candidateDir), 'library.sqlite3');
    const reportFile = path.join(path.resolve(projectionDir), 'report.json');
    const approval = projection.approval && {
      kind: projection.approval.kind,
      play_scope: projection.approval.play_scope,
      individual_map_review: projection.approval.individual_map_review,
      evidence_state: projection.approval.evidence_state,
    };
    const versionInput = { schema_version: 1, candidate_version: projection.candidate_version,
      candidate_db_sha256: projection.candidate_db_sha256,
      candidate_manifest_sha256: projection.candidate_manifest_sha256,
      included_map_ids: projection.included_map_ids,
      approved_event_urls: projection.approved_event_urls, approval };
    const sortedUnique = <T>(items: T[], compare: (a: T, b: T) => number) =>
      items.every((item, index) => index === 0 || compare(items[index - 1], item) < 0);
    if (projection.schema_version !== 1 || !VERSION.test(projection.version) ||
        projection.version !== hash(versionInput).slice(0, 20) ||
        projection.candidate_version !== candidates.version ||
        !SHA.test(projection.candidate_db_sha256) || !SHA.test(projection.candidate_manifest_sha256) ||
        projection.candidate_db_sha256 !== fileHash(candidateDbFile) ||
        projection.candidate_manifest_sha256 !== fileHash(candidateManifestFile) ||
        !Array.isArray(projection.included_map_ids) || projection.included_map_ids.length === 0 ||
        !projection.included_map_ids.every(id => Number.isSafeInteger(id) && id > 0) ||
        !sortedUnique(projection.included_map_ids, (a, b) => a - b) ||
        !Array.isArray(projection.approved_event_urls) || projection.approved_event_urls.length === 0 ||
        !projection.approved_event_urls.every(url => typeof url === 'string' && EVENT_URL.test(url)) ||
        !sortedUnique(projection.approved_event_urls, (a, b) => a < b ? -1 : a > b ? 1 : 0) ||
        !Array.isArray(projection.excluded_maps) ||
        !projection.excluded_maps.every((entry, i) => Number.isSafeInteger(entry.map_id) && entry.map_id > 0 &&
          (i === 0 || projection.excluded_maps[i - 1].map_id < entry.map_id) &&
          typeof entry.reason === 'string' && entry.reason.length > 0 &&
          typeof entry.source_url === 'string' && MAP_URL.test(entry.source_url)) ||
        (projection.approved_event_count !== undefined && projection.approved_event_count !== projection.approved_event_urls.length) ||
        (projection.included_map_count !== undefined && projection.included_map_count !== projection.included_map_ids.length) ||
        approval?.kind !== approvalKind || approval?.play_scope !== 'local' ||
        approval?.individual_map_review !== 'not_performed' ||
        approval?.evidence_state !== 'observed_unreviewed') {
      throw new Error('CSLINK_PLAY_INVALID_PROJECTION');
    }
    if (projection.files) {
      const reportRaw = fs.readFileSync(reportFile);
      const record = projection.files['report.json'];
      if (!record || record.bytes !== reportRaw.length || record.sha256 !== digestBuffer(reportRaw)) {
        throw new Error('CSLINK_PLAY_REPORT_CHECKSUM_MISMATCH');
      }
      const report = JSON.parse(reportRaw.toString('utf8'));
      if (report.schema_version !== 1 || report.version !== projection.version ||
          report.candidate_version !== candidates.version ||
          report.status !== (approvalKind === 'user_batch_scope_approval'
            ? 'user_batch_approved_local_play_only' : 'user_requested_legacy_import_local_play_only') ||
          report.approved_event_count !== projection.approved_event_urls.length ||
          report.included_map_count !== projection.included_map_ids.length ||
          report.excluded_map_count !== projection.excluded_maps.length ||
          report.sampled_map_count !== projection.included_map_ids.length + projection.excluded_maps.length ||
          report.individual_map_review !== 'not_performed' ||
          report.map_review_state !== 'observed_unreviewed' ||
          report.eligible_for_local_play !== true || report.eligible_for_public_release !== false ||
          (projection.approval_source_sha256 &&
            report.approval_source_sha256 !== projection.approval_source_sha256)) {
        throw new Error('CSLINK_PLAY_REPORT_MISMATCH');
      }
    }
    if (approvalKind === 'user_requested_legacy_import' && !projection.files) {
      throw new Error('CSLINK_PLAY_HISTORICAL_REPORT_REQUIRED');
    }
    return projection;
  }

  static async open(projectionDir: string, candidateDir: string,
    candidates: CsLinkCandidates, reviewed: CsLinkEvidence | null,
    historical: HistoricalPlayInput | null = null, legacy: CsLinkLegacy | null = null): Promise<CsLinkPlay> {
    const projection = this.validateProjection(projectionDir, candidateDir, candidates,
      'user_batch_scope_approval');
    const historicalProjection = historical ? this.validateProjection(historical.projectionDir,
      historical.candidateDir, historical.candidates, 'user_requested_legacy_import') : null;
    const Sqlite = require('better-sqlite3') as typeof Database;
    const db = new Sqlite(path.join(path.resolve(candidateDir), 'library.sqlite3'),
      { readonly: true, fileMustExist: true });
    let historicalDb: Database.Database | null = null;
    try {
      if (historical) historicalDb = new Sqlite(path.join(path.resolve(historical.candidateDir),
        'library.sqlite3'), { readonly: true, fileMustExist: true });
      for (const source of [db, historicalDb].filter((value): value is Database.Database => !!value)) {
        source.pragma('query_only = ON');
        if (source.pragma('integrity_check', { simple: true }) !== 'ok') {
          throw new Error('CSLINK_PLAY_CANDIDATE_DB_INTEGRITY');
        }
      }
      return new CsLinkPlay({ manifest: projection, db, candidates,
        dataset: 'hltv_candidate', approval: 'user_batch_scope_approval' }, reviewed,
      historical && historicalProjection && historicalDb ? {
        manifest: historicalProjection, db: historicalDb, candidates: historical.candidates,
        dataset: 'hltv_historical_candidate', approval: 'user_requested_legacy_import',
      } : null, legacy);
    } finally {
      db.close();
      historicalDb?.close();
    }
  }

  private addEdge(a: string, b: string, proof: PlayProof) {
    if (a === b || !PLAYER_ID.test(a) || !PLAYER_ID.test(b) ||
        !proof.lineup.some(p => p.id === a) || !proof.lineup.some(p => p.id === b)) {
      throw new Error('CSLINK_PLAY_INVALID_EDGE');
    }
    const key = pairKey(a, b);
    let edge = this.edges.get(key);
    if (!edge) {
      edge = { a, b, byMap: new Map(), proof };
      this.edges.set(key, edge);
    }
    const previous = edge.byMap.get(proof.mapId);
    if (previous) {
      const roster = (item: PlayProof) => item.lineup.map(p => p.id).sort().join('|');
      const score = (item: PlayProof) => item.score.join('|');
      if (roster(previous) !== roster(proof) || score(previous) !== score(proof)) {
        throw new Error('CSLINK_PLAY_OVERLAP_CONFLICT');
      }
      if (previous.reviewState === 'verified') return;
    }
    edge.byMap.set(proof.mapId, proof);
  }

  metadata() {
    return { bankVersion: this.bankVersion, dataVersion: this.dataVersion,
      total: this.pools.all.length, bridge: this.pools.bridge.length,
      multiple: this.pools.multiple.length, mode: 'local_play' as const,
      coverage: 'approved_as_tier_sample' as const,
      sampledMaps: this.sampledMaps, approvedEvents: this.approvedEvents,
      ...(this.legacy?.metadata() ?? {}),
      ...(this.historicalVersion ? { historicalMaps: this.historicalMapIds.size,
        historicalProjectionVersion: this.historicalProjectionVersion } : {}),
      distinctPlayers: this.graph.size, distinctPairs: this.edges.size,
      sourceVersions: { candidate: this.candidateVersion, verified: this.reviewedVersion,
        ...(this.historicalVersion ? { historical: this.historicalVersion } : {}),
        ...(this.legacy ? { legacy: this.legacy.version } : {}) },
      approval: { kind: 'user_batch_scope_approval' as const, individualMapReview: 'not_performed' as const },
      ...(this.historicalVersion ? { historicalApproval: {
        kind: 'user_requested_legacy_import' as const, individualMapReview: 'not_performed' as const } } : {}),
      reviewState: 'mixed_or_unreviewed' as const };
  }

  /** The merged inspection view may use this validated scope without mutating candidate records. */
  candidateScope() {
    return { version: this.dataVersion, mapIds: new Set(this.includedMapIds),
      candidateMapCounts: new Map([...this.players.keys()].map(id =>
        [id, this.currentCandidateMapCounts.get(id) ?? 0] as const)),
      approvedEventCount: this.currentApprovedEvents };
  }

  historicalScope() {
    if (!this.historicalCandidates || !this.historicalVersion) return null;
    return { candidates: this.historicalCandidates,
      combinedCandidateMapCounts: new Map([...this.players].map(([id, player]) =>
        [id, player.candidateMapCount] as const)),
      scope: { version: this.dataVersion, mapIds: new Set(this.historicalMapIds),
        candidateMapCounts: new Map(this.historicalCandidates.allPlayers().map(player =>
          [player.id, this.historicalCandidateMapCounts.get(player.id) ?? 0] as const)),
        approvedEventCount: this.historicalApprovedEvents } };
  }

  player(id: string) {
    const player = this.players.get(id);
    if (!player) throw new HttpError(404, 'CSLINK_PLAY_PLAYER_NOT_FOUND');
    return player;
  }

  /** Reuse one immutable proof snapshot for every round opened against this store. */
  pathGraph(): CsLinkPathGraph { return this.pathGraphSnapshot; }

  /** A room resolver only exposes connected identities from its pinned store. */
  getPathPlayer(id: string): PlayPlayer | null {
    const player = this.graph.has(id) ? this.players.get(id) : undefined;
    return player ? { ...player } : null;
  }

  search(query: string, candidates: CsLinkCandidates, reviewed: CsLinkEvidence | null) {
    const raw = query.trim().normalize('NFC');
    const ids = new Set<string>();
    for (const row of candidates.searchAll(raw)) ids.add(row.id);
    for (const row of this.historicalCandidates?.searchAll(raw) ?? []) ids.add(row.id);
    for (const row of this.legacy?.searchAll(raw) ?? []) ids.add(row.id);
    for (const row of reviewed?.searchAll(raw) ?? []) ids.add(`hltv:${row.hltvId}`);
    const items = [...ids].map(id => this.players.get(id))
      .filter((item): item is PlayPlayer => !!item && (item.verifiedMapCount > 0 || item.candidateMapCount > 0 || (item.legacyMapCount ?? 0) > 0));
    items.sort((a, b) => Number(b.nickname === raw) - Number(a.nickname === raw) ||
      b.verifiedMapCount - a.verifiedMapCount || b.candidateMapCount - a.candidateMapCount ||
      (b.legacyMapCount ?? 0) - (a.legacyMapCount ?? 0) || compareCsLinkPlayerIds(a.id, b.id));
    return { version: this.dataVersion, items: cslinkSearchResults(items, raw), total: items.length };
  }

  private checked(id: string, version: string) {
    if (version !== this.bankVersion) throw new HttpError(409, 'CSLINK_PLAY_VERSION_CHANGED');
    const q = this.questions.get(id);
    if (!q) throw new HttpError(404, 'CSLINK_PLAY_QUESTION_NOT_FOUND');
    return q;
  }

  private prompt(q: Question) {
    return { id: q.id, bankVersion: this.bankVersion, dataVersion: this.dataVersion,
      playerA: this.player(q.a), playerB: this.player(q.b), coverage: 'approved_as_tier_sample' as const };
  }

  question(pool: PlayPool, previous?: string) {
    const options = this.pools[pool];
    if (!options.length) throw new HttpError(404, 'CSLINK_PLAY_NO_QUESTIONS');
    const alternatives = previous && options.length > 1 ? options.filter(q => q.id !== previous) : options;
    return this.prompt(alternatives[crypto.randomInt(alternatives.length)]);
  }

  questionById(id: string, version: string) { return this.prompt(this.checked(id, version)); }

  private explanation(q: Question, playerId: string) {
    const side = (endpoint: string) => {
      const edge = this.edges.get(pairKey(endpoint, playerId));
      if (!edge) throw new Error('CSLINK_PLAY_MISSING_ANSWER_EDGE');
      return { endpoint: this.player(endpoint), evidenceCount: edge.byMap.size, proof: edge.proof };
    };
    return { player: this.player(playerId), left: side(q.a), right: side(q.b) };
  }

  answer(id: string, version: string, playerId: string) {
    const q = this.checked(id, version);
    const player = this.player(playerId);
    const status = playerId === q.a || playerId === q.b ? 'endpoint' :
      q.answerIds.includes(playerId) ? 'accepted' : 'not_confirmed';
    return { questionId: id, bankVersion: version, status, player,
      explanation: status === 'accepted' ? this.explanation(q, playerId) : null };
  }

  reveal(id: string, version: string) {
    const q = this.checked(id, version);
    return { questionId: id, bankVersion: version,
      coverage: 'approved_as_tier_sample' as const,
      answers: q.answerIds.map(playerId => this.explanation(q, playerId)) };
  }

  shortestPath(a: string, b: string, version: string) {
    if (version !== this.dataVersion) throw new HttpError(409, 'CSLINK_PLAY_VERSION_CHANGED');
    this.player(a); this.player(b);
    if (a === b) throw new HttpError(400, 'CSLINK_PLAY_SAME_PLAYER');
    const previous = new Map<string, string | null>([[a, null]]);
    const queue = [a];
    for (let i = 0; i < queue.length && !previous.has(b); i++) {
      for (const next of this.graph.get(queue[i]) ?? []) {
        if (!previous.has(next)) { previous.set(next, queue[i]); queue.push(next); }
      }
    }
    if (!previous.has(b)) return { dataVersion: this.dataVersion, status: 'not_connected_in_sample' as const,
      coverage: 'approved_as_tier_sample' as const, jumps: null, players: [], legs: [] };
    const path = [b];
    while (previous.get(path[0]) !== null) path.unshift(previous.get(path[0])!);
    const legs = path.slice(1).map((next, i) => {
      const edge = this.edges.get(pairKey(path[i], next))!;
      return { playerA: this.player(path[i]), playerB: this.player(next),
        evidenceCount: edge.byMap.size, proof: edge.proof };
    });
    return { dataVersion: this.dataVersion, status: 'connected' as const,
      coverage: 'approved_as_tier_sample' as const, jumps: legs.length,
      players: path.map(id => this.player(id)), legs };
  }
}
