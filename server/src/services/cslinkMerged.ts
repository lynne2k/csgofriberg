import crypto from 'crypto';
import { HttpError } from '../middleware/common';
import { CsLinkCandidates } from './cslinkCandidates';
import { CsLinkEvidence } from './cslinkEvidence';
import { CsLinkLegacy, compareCsLinkPlayerIds, cslinkPairKey, cslinkSearchResults } from './cslinkLegacy';

interface MergedPlayer {
  id: string;
  hltvId: string | null;
  nickname: string;
  profileUrl: string | null;
  identityKind?: 'hltv' | 'legacy_context';
  identityContext?: string;
  legacyMapCount?: number;
  verifiedMapCount: number;
  candidateMapCount: number;
}

type VerifiedProof = ReturnType<CsLinkEvidence['relationship']>['evidence'][number];
type CandidateProof = ReturnType<CsLinkCandidates['relationship']>['evidence'][number];

const HLTV_ID = /^[1-9]\d{0,9}$/;
const PAGE_SIZE = 50;

export interface CandidatePlayScope {
  version: string;
  mapIds: ReadonlySet<number>;
  candidateMapCounts: ReadonlyMap<string, number>;
  approvedEventCount: number;
}

export interface HistoricalMergedSource {
  candidates: CsLinkCandidates;
  scope: CandidatePlayScope;
  combinedCandidateMapCounts?: ReadonlyMap<string, number>;
}

/** A read-only projection. Neither source store nor gameplay eligibility is modified. */
export class CsLinkMerged {
  readonly version: string;
  readonly distinctPairs: number;
  private readonly players = new Map<string, MergedPlayer>();
  private readonly reviewedIds = new Map<string, string>();
  private readonly reviewedHltvById = new Map<string, string>();
  private readonly candidateIds = new Set<string>();
  private readonly historicalIds = new Set<string>();
  private readonly legacy: CsLinkLegacy | null;

  constructor(private readonly reviewed: CsLinkEvidence | null,
    private readonly candidates: CsLinkCandidates | null,
    private readonly candidateScope: CandidatePlayScope | null = null,
    private readonly historical: HistoricalMergedSource | null = null, legacy: CsLinkLegacy | null = null) {
    if (!reviewed && !candidates && !historical && !legacy) throw new Error('CSLINK_MERGED_NO_SOURCES');
    this.version = crypto.createHash('sha256').update(JSON.stringify({
      schema: 'cslink-merged-v1', verified: reviewed?.version ?? null,
      candidate: candidates?.version ?? null,
      ...(candidateScope ? { scope: candidateScope.version } : {}),
      ...(historical ? { historical: { candidate: historical.candidates.version,
        scope: historical.scope.version } } : {}),
      ...(legacy ? { legacy: legacy.version } : {}),
    })).digest('hex').slice(0, 20);

    for (const player of reviewed?.allPlayers() ?? []) {
      if (!HLTV_ID.test(player.hltvId)) throw new Error('CSLINK_MERGED_INVALID_REVIEWED_ID');
      const id = `hltv:${player.hltvId}`;
      if (this.reviewedIds.has(id)) throw new Error('CSLINK_MERGED_DUPLICATE_REVIEWED_ID');
      this.reviewedIds.set(id, player.id);
      this.reviewedHltvById.set(player.id, id);
      this.players.set(id, { id, hltvId: player.hltvId, nickname: player.nickname,
        profileUrl: player.profileUrl, verifiedMapCount: player.verifiedMapCount,
        candidateMapCount: 0 });
    }
    for (const player of candidates?.allPlayers() ?? []) {
      if (!HLTV_ID.test(player.hltvId) || player.id !== `hltv:${player.hltvId}`) {
        throw new Error('CSLINK_MERGED_INVALID_CANDIDATE_ID');
      }
      const existing = this.players.get(player.id);
      const scopedCount = candidateScope?.candidateMapCounts.get(player.id) ?? player.evidenceMapCount;
      if (candidateScope && scopedCount === 0) continue;
      this.candidateIds.add(player.id);
      // The newer nickname is a display choice, not an identity key. Both source labels remain searchable.
      this.players.set(player.id, { id: player.id, hltvId: player.hltvId,
        nickname: player.nickname, profileUrl: player.profileUrl,
        verifiedMapCount: existing?.verifiedMapCount ?? 0,
        candidateMapCount: scopedCount });
    }
    for (const player of historical?.candidates.allPlayers() ?? []) {
      if (!HLTV_ID.test(player.hltvId) || player.id !== `hltv:${player.hltvId}`) {
        throw new Error('CSLINK_MERGED_INVALID_HISTORICAL_ID');
      }
      const scopedCount = historical!.scope.candidateMapCounts.get(player.id) ?? 0;
      if (scopedCount === 0) continue;
      const existing = this.players.get(player.id);
      this.historicalIds.add(player.id);
      this.players.set(player.id, { id: player.id, hltvId: player.hltvId,
        nickname: existing?.nickname ?? player.nickname,
        profileUrl: existing?.profileUrl ?? player.profileUrl,
        verifiedMapCount: existing?.verifiedMapCount ?? 0,
        candidateMapCount: historical!.combinedCandidateMapCounts?.get(player.id) ??
          (existing?.candidateMapCount ?? 0) + scopedCount });
    }
    const pairs = new Set<string>();
    const occupiedMapIds = new Set<number>();
    const addPair = (a: string | undefined, b: string | undefined) => {
      if (!a || !b || !this.players.has(a) || !this.players.has(b) || a === b) {
        throw new Error('CSLINK_MERGED_UNRESOLVED_PAIR');
      }
      pairs.add(cslinkPairKey(a, b));
    };
    for (const edge of reviewed?.verifiedPairs() ?? []) {
      addPair(this.reviewedHltvById.get(edge.player_a), this.reviewedHltvById.get(edge.player_b));
      if (legacy) for (const proof of this.allReviewed(edge.player_a, edge.player_b).evidence) occupiedMapIds.add(proof.mapId);
    }
    const addCandidatePairs = (store: CsLinkCandidates | null, scope: CandidatePlayScope | null) => {
      for (const edge of store?.candidatePairs() ?? []) {
        if (scope || legacy) {
          const result = store!.relationship(`hltv:${edge.player_a}`, `hltv:${edge.player_b}`,
            store!.version, 0);
          const evidence = [...result.evidence];
          while (evidence.length < result.total) {
            const page = store!.relationship(`hltv:${edge.player_a}`, `hltv:${edge.player_b}`,
              store!.version, evidence.length);
            if (!page.evidence.length) throw new Error('CSLINK_MERGED_CANDIDATE_PAGINATION_STALLED');
            evidence.push(...page.evidence);
          }
          const included = evidence.filter(proof => !scope || scope.mapIds.has(proof.mapId));
          for (const proof of included) occupiedMapIds.add(proof.mapId);
          if (!included.length) continue;
        }
        addPair(`hltv:${edge.player_a}`, `hltv:${edge.player_b}`);
      }
    };
    addCandidatePairs(candidates, candidateScope);
    if (historical) addCandidatePairs(historical.candidates, historical.scope);
    this.legacy = legacy?.excludingMaps(occupiedMapIds) ?? null;
    for (const player of this.legacy?.allPlayers() ?? []) {
      const existing = this.players.get(player.id);
      this.players.set(player.id, existing ? { ...existing, legacyMapCount: player.legacyMapCount,
        identityKind: 'hltv' } : player);
    }
    for (const [a, b] of this.legacy?.pairs() ?? []) addPair(a, b);
    this.distinctPairs = pairs.size;
  }

  metadata() {
    const reviewedMeta = this.reviewed?.metadata();
    const candidateMeta = this.candidates?.metadata();
    const historicalMeta = this.historical?.candidates.metadata();
    const reviewedExample = reviewedMeta?.example?.map(player => `hltv:${player.hltvId}`);
    const exampleIds = reviewedExample ?? this.candidates?.examplePair() ??
      this.historical?.candidates.examplePair() ?? this.legacy?.pairs()[0] ?? null;
    const currentIds = this.candidateScope?.mapIds ?? null;
    const historicalIds = this.historical?.scope.mapIds ?? null;
    let sampledMaps = currentIds?.size ?? candidateMeta?.capturedMaps ?? 0;
    if (historicalIds) sampledMaps = currentIds
      ? new Set([...currentIds, ...historicalIds]).size
      : sampledMaps + historicalIds.size;
    sampledMaps += this.legacy?.maps.length ?? 0;
    return {
      ...(this.legacy?.metadata() ?? {}),
      version: this.version, mode: 'local_merged_preview' as const,
      coverage: 'partial_sample' as const, eligibleForQuestions: false as const,
      sourceVersions: { verified: this.reviewed?.version ?? null,
        candidate: this.candidates?.version ?? null,
        ...(this.historical ? { historical: this.historical.candidates.version } : {}),
        ...(this.legacy ? { legacy: this.legacy.version } : {}) },
      candidateScope: this.candidateScope || this.historical
        ? 'local_play_approved' as const : 'unreviewed_full_sample' as const,
      playScopeApplied: !!this.candidateScope || !!this.historical,
      excludedMaps: (this.candidateScope ? (candidateMeta?.capturedMaps ?? 0) - this.candidateScope.mapIds.size : 0) +
        (this.historical ? (historicalMeta?.capturedMaps ?? 0) - this.historical.scope.mapIds.size : 0),
      approvedEvents: (this.candidateScope?.approvedEventCount ?? 0) +
        (this.historical?.scope.approvedEventCount ?? 0),
      sourceAvailability: { verified: !!this.reviewed, candidate: !!this.candidates,
        ...(this.historical ? { historical: true } : {}),
        ...(this.legacy ? { legacy: true } : {}) },
      verifiedMaps: reviewedMeta?.verifiedMaps ?? 0,
      rawSampledMaps: (candidateMeta?.capturedMaps ?? 0) + (historicalMeta?.capturedMaps ?? 0),
      sampledMaps,
      ...(this.historical ? { historicalRawSampledMaps: historicalMeta?.capturedMaps ?? 0,
        historicalSampledMaps: historicalIds!.size } : {}),
      distinctPlayers: this.players.size,
      distinctPairs: this.distinctPairs,
      example: exampleIds?.map(id => this.players.get(id)!) ?? null,
    };
  }

  search(query: string) {
    const raw = query.trim().normalize('NFC');
    const ids = new Set<string>();
    for (const player of this.reviewed?.searchAll(raw) ?? []) ids.add(`hltv:${player.hltvId}`);
    for (const player of this.candidates?.searchAll(raw) ?? []) ids.add(player.id);
    for (const player of this.historical?.candidates.searchAll(raw) ?? []) ids.add(player.id);
    for (const player of this.legacy?.searchAll(raw) ?? []) ids.add(player.id);
    const items = [...ids].map(id => this.players.get(id)).filter((item): item is MergedPlayer => !!item);
    items.sort((a, b) => Number(b.nickname === raw) - Number(a.nickname === raw) ||
      b.verifiedMapCount - a.verifiedMapCount || b.candidateMapCount - a.candidateMapCount ||
      (b.legacyMapCount ?? 0) - (a.legacyMapCount ?? 0) || compareCsLinkPlayerIds(a.id, b.id));
    return { version: this.version, items: cslinkSearchResults(items, raw), total: items.length };
  }

  private allReviewed(a: string, b: string) {
    const first = this.reviewed!.relationship(a, b, this.reviewed!.version, 0);
    const evidence = [...first.evidence];
    while (evidence.length < first.total) {
      const next = this.reviewed!.relationship(a, b, this.reviewed!.version, evidence.length);
      if (next.evidence.length === 0) throw new Error('CSLINK_MERGED_REVIEWED_PAGINATION_STALLED');
      evidence.push(...next.evidence);
    }
    return { total: first.total, evidence };
  }

  private allCandidates(store: CsLinkCandidates, a: string, b: string) {
    const first = store.relationship(a, b, store.version, 0);
    const evidence = [...first.evidence];
    while (evidence.length < first.total) {
      const next = store.relationship(a, b, store.version, evidence.length);
      if (next.evidence.length === 0) throw new Error('CSLINK_MERGED_CANDIDATE_PAGINATION_STALLED');
      evidence.push(...next.evidence);
    }
    return { total: first.total, evidence };
  }

  private verifiedProof(proof: VerifiedProof) {
    return { ...proof,
      lineup: proof.lineup.map(player => ({ ...player, id: `hltv:${player.hltvId}` })),
      reviewState: 'verified' as const, scopeStatus: 'legacy_scope_unreviewed' as const,
      sourceDataset: 'cslink_review' as const, datasetVersion: this.reviewed!.version,
      sourceFingerprint: proof.recordSha256,
      corroboratingSources: [] as { sourceDataset: 'hltv_candidate' | 'hltv_historical_candidate'; datasetVersion: string;
        sourceUrl: string; sourceFingerprint: string; reviewState: 'unreviewed' }[],
    };
  }

  private candidateProof(proof: CandidateProof, store: CsLinkCandidates,
    historical: boolean) {
    return { ...proof, scopeStatus: historical ? 'historical_as_tier_local' as const :
      this.candidateScope ? 'as_tier_batch_approved' as const : 'as_tier_pending' as const,
      sourceDataset: historical ? 'hltv_historical_candidate' as const : 'hltv_candidate' as const,
      datasetVersion: store.version,
      sourceFingerprint: proof.captureSha256,
      corroboratingSources: [] as { sourceDataset: 'hltv_candidate' | 'hltv_historical_candidate';
        datasetVersion: string; sourceUrl: string; sourceFingerprint: string;
        reviewState: 'unreviewed' }[],
    };
  }

  private assertSameMap(reviewed: ReturnType<CsLinkMerged['verifiedProof']> |
    ReturnType<CsLinkMerged['candidateProof']>, candidate: ReturnType<CsLinkMerged['candidateProof']>) {
    const signature = (proof: typeof reviewed | typeof candidate) => {
      const lineup = proof.lineup.map(player => player.id).sort();
      const teamIndex = proof.opponents.indexOf(proof.team);
      if (lineup.length !== 5 || new Set(lineup).size !== 5 || teamIndex < 0 || teamIndex > 1 ||
          proof.score.length !== 2 || proof.score.some(score => !Number.isFinite(score))) {
        throw new HttpError(409, 'CSLINK_MERGED_SOURCE_CONFLICT');
      }
      return {
        lineup: lineup.join('|'), map: proof.map.normalize('NFKC').toLowerCase().replace(/[\s_-]/g, ''),
        ownScore: proof.score[teamIndex], opponentScore: proof.score[1 - teamIndex],
      };
    };
    const left = signature(reviewed), right = signature(candidate);
    if (left.lineup !== right.lineup || left.map !== right.map ||
        left.ownScore !== right.ownScore || left.opponentScore !== right.opponentScore) {
      throw new HttpError(409, 'CSLINK_MERGED_SOURCE_CONFLICT');
    }
  }

  relationship(a: string, b: string, version: string, offset: number) {
    if (version !== this.version) throw new HttpError(409, 'CSLINK_MERGED_VERSION_CHANGED');
    const playerA = this.players.get(a), playerB = this.players.get(b);
    if (!playerA || !playerB) throw new HttpError(404, 'CSLINK_MERGED_PLAYER_NOT_FOUND');
    if (a === b) throw new HttpError(400, 'CSLINK_MERGED_SAME_PLAYER');

    const reviewedA = this.reviewedIds.get(a), reviewedB = this.reviewedIds.get(b);
    const verified = this.reviewed && reviewedA && reviewedB
      ? this.allReviewed(reviewedA, reviewedB) : { total: 0, evidence: [] as VerifiedProof[] };
    const candidate = this.candidates && this.candidateIds.has(a) && this.candidateIds.has(b)
      ? this.allCandidates(this.candidates, a, b) : { total: 0, evidence: [] as CandidateProof[] };
    const historical = this.historical && this.historicalIds.has(a) && this.historicalIds.has(b)
      ? this.allCandidates(this.historical.candidates, a, b)
      : { total: 0, evidence: [] as CandidateProof[] };

    const byMap = new Map<number, ReturnType<CsLinkMerged['verifiedProof']> |
      ReturnType<CsLinkMerged['candidateProof']>>();
    for (const proof of historical.evidence) {
      if (this.historical!.scope.mapIds.has(proof.mapId)) {
        byMap.set(proof.mapId, this.candidateProof(proof, this.historical!.candidates, true));
      }
    }
    for (const proof of candidate.evidence) {
      if (!this.candidateScope || this.candidateScope.mapIds.has(proof.mapId)) {
        const currentProof = this.candidateProof(proof, this.candidates!, false);
        const overlap = byMap.get(proof.mapId);
        if (overlap) {
          this.assertSameMap(overlap, currentProof);
          currentProof.corroboratingSources.push({ sourceDataset: 'hltv_historical_candidate',
            datasetVersion: overlap.datasetVersion, sourceUrl: overlap.sourceUrl,
            sourceFingerprint: overlap.sourceFingerprint, reviewState: 'unreviewed' });
        }
        byMap.set(proof.mapId, currentProof);
      }
    }
    // A reviewed map wins if the same map was also sampled by the newer capture.
    for (const proof of verified.evidence) {
      const reviewedProof = this.verifiedProof(proof);
      const overlap = byMap.get(proof.mapId);
      if (overlap) {
        if (overlap.sourceDataset !== 'hltv_candidate' &&
            overlap.sourceDataset !== 'hltv_historical_candidate') {
          throw new HttpError(409, 'CSLINK_MERGED_SOURCE_CONFLICT');
        }
        this.assertSameMap(reviewedProof, overlap);
        byMap.set(proof.mapId, { ...reviewedProof, corroboratingSources: [
          ...overlap.corroboratingSources, {
          sourceDataset: overlap.sourceDataset, datasetVersion: overlap.datasetVersion,
          sourceUrl: overlap.sourceUrl, sourceFingerprint: overlap.sourceFingerprint,
          reviewState: overlap.reviewState,
        }] });
      } else {
        byMap.set(proof.mapId, reviewedProof);
      }
    }
    // Date displays have unknown source timezones; the HLTV map ID is a stable order key.
    const legacyProofs = (this.legacy?.relationship(a, b) ?? [])
      .filter(proof => !byMap.has(proof.mapId)).map(proof => ({ ...proof,
        datasetVersion: this.legacy!.version, corroboratingSources: [] }));
    const all = [...byMap.values(), ...legacyProofs].sort((x, y) => y.mapId - x.mapId);
    const verifiedTotal = all.filter(proof => proof.reviewState === 'verified').length;
    const candidateTotal = all.length - verifiedTotal;
    const evidence = all.slice(offset, offset + PAGE_SIZE);
    return {
      version: this.version, coverage: 'partial_sample' as const, playerA, playerB,
      status: verifiedTotal > 0 ? 'confirmed' as const :
        candidateTotal > 0 ? 'candidate_evidence' as const : 'not_found_in_loaded_data' as const,
      total: all.length, verifiedTotal, candidateTotal,
      offset, hasMore: offset + evidence.length < all.length, evidence,
    };
  }
}
