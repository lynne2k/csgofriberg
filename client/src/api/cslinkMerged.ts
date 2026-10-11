export interface MergedPlayer {
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

export interface MergedMetadata {
  version: string;
  sourceVersions: { verified: string | null; candidate: string | null; historical?: string; legacy?: string };
  sourceAvailability: { verified: boolean; candidate: boolean; historical?: boolean; legacy?: boolean };
  verifiedMaps: number;
  rawSampledMaps: number;
  sampledMaps: number;
  historicalRawSampledMaps?: number;
  historicalSampledMaps?: number;
  legacyImportedMaps?: number;
  legacyInternalPlayers?: number;
  legacyVersion?: string;
  excludedMaps: number;
  approvedEvents: number;
  playScopeApplied: boolean;
  candidateScope: 'local_play_approved' | 'unreviewed_full_sample';
  distinctPlayers: number;
  distinctPairs: number;
  example: [MergedPlayer, MergedPlayer] | null;
  coverage: 'partial_sample';
  eligibleForQuestions: false;
}

export interface MergedEvidence {
  mapId: number;
  event: string;
  eventUrl?: string;
  tier?: string;
  map: string;
  dateRaw: string;
  team: string;
  opponents: string[];
  score: number[];
  sourceUrl: string;
  lineup: MergedPlayer[];
  opponentLineup?: MergedPlayer[];
  reviewState: 'verified' | 'unreviewed';
  scopeStatus: 'legacy_scope_unreviewed' | 'as_tier_pending' | 'as_tier_batch_approved' | 'historical_as_tier_local' | 'legacy_as_import';
  sourceDataset: 'cslink_review' | 'hltv_candidate' | 'hltv_historical_candidate' | 'legacy_dataset';
  datasetVersion: string;
  sourceFingerprint: string;
  review?: { status: 'verified'; reviewedOn: string; reviewedBy: string };
  corroboratingSources?: { sourceDataset: string; datasetVersion: string; sourceUrl: string; sourceFingerprint: string;
    reviewState: 'unreviewed' }[];
}

export function playerIdentityLabel(player: MergedPlayer): string {
  return player.hltvId ? `HLTV #${player.hltvId}` :
    `旧库身份${player.identityContext ? ` · ${player.identityContext}` : ''}`;
}

export interface MergedRelationship {
  version: string;
  playerA: MergedPlayer;
  playerB: MergedPlayer;
  status: 'confirmed' | 'candidate_evidence' | 'not_found_in_loaded_data';
  total: number;
  verifiedTotal: number;
  candidateTotal: number;
  offset: number;
  hasMore: boolean;
  evidence: MergedEvidence[];
}

export function mergedError(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
  const messages: Record<string, string> = {
    CSLINK_MERGED_DISABLED: '综合关系查询目前仅在本地开发环境开放。',
    CSLINK_MERGED_UNAVAILABLE: '关系数据尚未加载，请检查本地数据版本。',
    CSLINK_MERGED_VERSION_CHANGED: '数据版本已更新，请重新选择选手。',
    CSLINK_MERGED_PLAYER_NOT_FOUND: '当前关系库没有这名选手，请重新搜索。',
    CSLINK_MERGED_SAME_PLAYER: '请选择两名不同的选手。',
    CSLINK_MERGED_SOURCE_CONFLICT: '两个数据批次对同一地图的记录不一致，已暂停合并显示，请查看复核日志。',
  };
  return { code, message: messages[code ?? ''] ?? '查询失败，请重试。' };
}
