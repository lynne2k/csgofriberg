export interface CandidatePlayer {
  id: string;
  hltvId: string;
  nickname: string;
  profileUrl: string;
  evidenceMapCount: number;
}

export interface CandidateMetadata {
  version: string;
  mode: 'candidate_review';
  coverage: 'sampled';
  capturedMaps: number;
  distinctPlayers: number;
  candidatePairs: number;
  reviewState: 'unreviewed';
  eligibleForQuestions: false;
}

export interface CandidateEvidence {
  mapId: number;
  event: string;
  eventUrl: string;
  tier: string;
  map: string;
  dateRaw: string;
  team: string;
  opponents: string[];
  score: number[];
  sourceUrl: string;
  lineup: CandidatePlayer[];
  opponentLineup: CandidatePlayer[];
  reviewState: 'unreviewed';
  captureSha256: string;
  captureProvenanceStatus?: string;
}

export interface CandidateRelationship {
  version: string;
  coverage: 'sampled';
  playerA: CandidatePlayer;
  playerB: CandidatePlayer;
  status: 'candidate_evidence' | 'not_found_in_sample';
  total: number;
  offset: number;
  hasMore: boolean;
  evidence: CandidateEvidence[];
}

export function candidateError(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
  const messages: Record<string, string> = {
    CSLINK_CANDIDATES_DISABLED: '此候选库目前仅在本地开发环境开放。',
    CSLINK_CANDIDATES_UNAVAILABLE: '候选关系库尚未加载，请检查本地数据构建结果。',
    CSLINK_CANDIDATE_VERSION_CHANGED: '候选库版本已更新，请重新选择选手。',
    CSLINK_CANDIDATE_PLAYER_NOT_FOUND: '当前候选库没有这名选手。',
    CSLINK_CANDIDATE_SAME_PLAYER: '请选择两名不同的选手。',
  };
  return { code, message: messages[code ?? ''] ?? '候选关系查询失败，请重试。' };
}
