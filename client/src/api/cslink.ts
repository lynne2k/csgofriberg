export interface EvidencePlayer {
  id: string;
  nickname: string;
  name: string | null;
  hltvId: string;
  profileUrl: string;
  verifiedMapCount: number;
}

export interface EvidenceMetadata {
  version: string;
  mode: 'local_review';
  coverage: 'partial';
  rightsStatus: string;
  registeredPlayers: number;
  verifiedMaps: number;
  verifiedDateRangeRaw: { first: string | null; last: string | null };
  example: [EvidencePlayer, EvidencePlayer] | null;
}

export interface RelationshipResult {
  version: string;
  coverage: 'partial';
  playerA: EvidencePlayer;
  playerB: EvidencePlayer;
  status: 'confirmed' | 'not_found_in_reviewed_data';
  total: number;
  offset: number;
  hasMore: boolean;
  evidence: {
    mapId: number;
    event: string;
    map: string;
    dateRaw: string;
    timezone: string;
    team: string;
    opponents: string[];
    score: number[];
    sourceUrl: string;
    lineup: EvidencePlayer[];
    review: { status: 'verified'; reviewedOn: string; reviewedBy: string };
    recordSha256: string;
    sourceRefs: Record<string, { file: string; csv_record: number }[]>;
  }[];
}

export function evidenceError(error: unknown) {
  const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
  const messages: Record<string, string> = {
    CSLINK_DISABLED: '此页面目前仅用于本地来源复核。',
    CSLINK_UNAVAILABLE: '复核数据尚未加载，请检查本地数据版本后重试。',
    CSLINK_VERSION_CHANGED: '数据版本已更新，请更新版本后重新选择选手。',
    CSLINK_PLAYER_NOT_FOUND: '当前版本没有这名选手，请重新搜索并选择。',
    CSLINK_SAME_PLAYER: '请选择两名不同的选手。',
    CSLINK_QUESTION_NOT_FOUND: '这道题不在当前版本中，请换一道题。',
    CSLINK_NO_QUESTIONS: '当前数据还没有符合这个模式的候选题，请切换模式。',
  };
  return { code, message: messages[code ?? ''] ?? '查询失败，请重试。' };
}

export type QuestionPool = 'bridge' | 'multiple' | 'all';
export interface PracticeMeta {
  bankVersion: string; dataVersion: string; total: number; bridge: number; multiple: number;
  mode: 'local_practice'; coverage: 'partial'; releaseReady: false; rightsStatus: string;
  verifiedDateRangeRaw: { first: string | null; last: string | null };
}
export interface PracticeQuestion {
  id: string; bankVersion: string; dataVersion: string; playerA: EvidencePlayer; playerB: EvidencePlayer; coverage: 'partial';
}
export interface AnswerExplanation {
  player: EvidencePlayer;
  left: { endpoint: EvidencePlayer; evidenceCount: number; proof: RelationshipResult['evidence'][number] };
  right: { endpoint: EvidencePlayer; evidenceCount: number; proof: RelationshipResult['evidence'][number] };
}
export interface PracticeAnswer {
  questionId: string; bankVersion: string; player: EvidencePlayer;
  status: 'accepted' | 'not_confirmed' | 'endpoint'; explanation: AnswerExplanation | null;
}
export interface PracticeReveal {
  questionId: string; bankVersion: string; coverage: 'partial'; answers: AnswerExplanation[];
}
