import type { MergedPlayer } from './cslinkMerged';

export type PlayPlayer = MergedPlayer;
export type PlayPool = 'bridge' | 'multiple' | 'all';

export interface PlayMeta {
  bankVersion: string;
  dataVersion: string;
  total: number;
  bridge: number;
  multiple: number;
  sampledMaps: number;
  historicalMaps?: number;
  legacyImportedMaps?: number;
  legacyInternalPlayers?: number;
  legacyVersion?: string;
  approvedEvents: number;
  sourceVersions: { candidate: string; verified: string | null; historical?: string; legacy?: string };
  approval: { kind: 'user_batch_scope_approval'; individualMapReview: 'not_performed' };
  mode: 'local_play';
  coverage: 'approved_as_tier_sample';
  reviewState: 'mixed_or_unreviewed';
}

export interface PlayQuestion {
  id: string;
  bankVersion: string;
  dataVersion: string;
  playerA: PlayPlayer;
  playerB: PlayPlayer;
  coverage: 'approved_as_tier_sample';
}

export interface PlayProof {
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
  lineup: PlayPlayer[];
  opponentLineup?: PlayPlayer[];
  reviewState: 'verified' | 'unreviewed';
  sourceFingerprint: string;
  sourceDataset: string;
  scopeApproval: 'user_batch_scope_approval' | 'user_requested_legacy_import' | 'legacy';
}

export interface PlayExplanation {
  player: PlayPlayer;
  left: { endpoint: PlayPlayer; evidenceCount: number; proof: PlayProof };
  right: { endpoint: PlayPlayer; evidenceCount: number; proof: PlayProof };
}

export interface PlayAnswer {
  questionId: string;
  bankVersion: string;
  player: PlayPlayer;
  status: 'accepted' | 'not_confirmed' | 'endpoint';
  explanation: PlayExplanation | null;
}

export interface PlayReveal {
  questionId: string;
  bankVersion: string;
  coverage: 'approved_as_tier_sample';
  answers: PlayExplanation[];
}

export function playError(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
  const messages: Record<string, string> = {
    CSLINK_PLAY_DISABLED: '本地对战图仅在开发环境开放。',
    CSLINK_PLAY_UNAVAILABLE: '本地对战图尚未加载，请检查数据投影。',
    CSLINK_PLAY_VERSION_CHANGED: '题库已更新，请重新抽题。',
    CSLINK_PLAY_PLAYER_NOT_FOUND: '当前版本没有这名选手。',
    CSLINK_PLAY_SAME_PLAYER: '请选择两名不同的选手。',
    CSLINK_PLAY_QUESTION_NOT_FOUND: '这道题不在当前版本中，请换一道题。',
    CSLINK_PLAY_NO_QUESTIONS: '此模式暂时没有可用题目，请切换模式。',
    CSLINK_VERSION_CHANGED: '题库已更新，请重新抽题。',
  };
  return { code, message: messages[code ?? ''] ?? '本地对战图暂时无法响应，请重试。' };
}
