import crypto from 'crypto';
import { HttpError } from '../middleware/common';
import { CsLinkEvidence } from './cslinkEvidence';

const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const pairKey = (a: string, b: string) => [a, b].sort().join('|');
export const QUESTION_RULES = {
  version: 'common-teammate-v1', minAnswers: 1, maxAnswers: 3,
  scope: 'verified_official_actual_map_appearances', coverage: 'partial',
  excludeEndpoints: true, acceptAllCommonNeighbors: true,
} as const;
export type QuestionPool = 'bridge' | 'multiple' | 'all';
type Proof = ReturnType<CsLinkEvidence['relationship']>['evidence'][number];
export interface VerifiedLink { a: string; b: string; proof: Proof; evidenceCount: number }

/** Pure, deterministic enumeration over stable IDs; display names never enter the graph. */
export function buildQuestionBank(dataVersion: string, links: VerifiedLink[]) {
  const edges = new Map<string, VerifiedLink>();
  const graph = new Map<string, Set<string>>();
  for (const link of links) {
    if (link.a === link.b || edges.has(pairKey(link.a, link.b)) || link.evidenceCount < 1 ||
        link.proof.review.status !== 'verified' || !link.proof.lineup.some(p => p.id === link.a) ||
        !link.proof.lineup.some(p => p.id === link.b)) throw new Error('CSLINK_INVALID_GRAPH_EDGE');
    edges.set(pairKey(link.a, link.b), link);
    for (const [a, b] of [[link.a, link.b], [link.b, link.a]]) {
      if (!graph.has(a)) graph.set(a, new Set());
      graph.get(a)!.add(b);
    }
  }
  const ids = [...graph.keys()].sort();
  const questions = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    const common = [...graph.get(a)!].filter(id => id !== a && id !== b && graph.get(b)!.has(id)).sort();
    // Filter whole questions; never truncate an otherwise valid answer set.
    if (common.length < QUESTION_RULES.minAnswers || common.length > QUESTION_RULES.maxAnswers) continue;
    const answers = common.map(playerId => {
      const left = edges.get(pairKey(a, playerId))!, right = edges.get(pairKey(b, playerId))!;
      const ref = (edge: VerifiedLink) => ({ mapId: edge.proof.mapId, sourceUrl: edge.proof.sourceUrl,
        recordSha256: edge.proof.recordSha256, evidenceCount: edge.evidenceCount });
      return { playerId, left: ref(left), right: ref(right) };
    });
    questions.push({ id: hash([dataVersion, QUESTION_RULES, a, b]), playerA: a, playerB: b,
      endpointsHaveConfirmedEdge: graph.get(a)!.has(b), answerIds: common, answers,
      reviewStatus: 'pending' as const, eligibleForRelease: false as const });
  }
  const bankVersion = hash({ dataVersion, rules: QUESTION_RULES, questions });
  return { bankVersion, dataVersion, rules: QUESTION_RULES, questions, releaseReady: false as const };
}

/** Local practice only: no public ranking, multiplayer state, or release approval. */
export class CsLinkQuestions {
  readonly bank: ReturnType<typeof buildQuestionBank>;
  private links = new Map<string, VerifiedLink>();
  private questions: Map<string, ReturnType<typeof buildQuestionBank>['questions'][number]>;

  constructor(private evidence: CsLinkEvidence) {
    const links = evidence.verifiedPairs().map(({ player_a: a, player_b: b }) => {
      const result = evidence.relationship(a, b, evidence.version);
      if (!result.evidence[0]) throw new Error('CSLINK_MISSING_QUESTION_EVIDENCE');
      return { a, b, proof: result.evidence[0], evidenceCount: result.total };
    });
    this.bank = buildQuestionBank(evidence.version, links);
    for (const link of links) this.links.set(pairKey(link.a, link.b), link);
    this.questions = new Map(this.bank.questions.map(q => [q.id, q]));
  }

  metadata() {
    const q = this.bank.questions;
    return { bankVersion: this.bank.bankVersion, dataVersion: this.bank.dataVersion,
      total: q.length, bridge: q.filter(x => !x.endpointsHaveConfirmedEdge).length,
      multiple: q.filter(x => x.answerIds.length > 1).length,
      mode: 'local_practice' as const, coverage: 'partial' as const, releaseReady: false as const,
      rightsStatus: this.evidence.rightsStatus, verifiedDateRangeRaw: this.evidence.metadata().verifiedDateRangeRaw };
  }

  private checked(id: string, version: string) {
    if (version !== this.bank.bankVersion) throw new HttpError(409, 'CSLINK_VERSION_CHANGED');
    const q = this.questions.get(id);
    if (!q) throw new HttpError(404, 'CSLINK_QUESTION_NOT_FOUND');
    return q;
  }

  question(pool: QuestionPool, previous?: string) {
    const items = this.bank.questions.filter(q => pool === 'all' ||
      (pool === 'bridge' ? !q.endpointsHaveConfirmedEdge : q.answerIds.length > 1));
    const alternatives = items.filter(q => q.id !== previous);
    const candidates = alternatives.length ? alternatives : items;
    if (!candidates.length) throw new HttpError(404, 'CSLINK_NO_QUESTIONS');
    const q = candidates[crypto.randomInt(candidates.length)];
    return this.prompt(q);
  }

  questionById(id: string, version: string) {
    return this.prompt(this.checked(id, version));
  }

  private prompt(q: ReturnType<CsLinkQuestions['checked']>) {
    // A fixed link still exposes only the prompt. Answers and proofs remain server-side.
    return { id: q.id, bankVersion: this.bank.bankVersion, dataVersion: this.bank.dataVersion,
      playerA: this.evidence.player(q.playerA), playerB: this.evidence.player(q.playerB),
      coverage: 'partial' as const };
  }

  private explanation(q: ReturnType<CsLinkQuestions['checked']>, playerId: string) {
    const side = (endpoint: string) => {
      const edge = this.links.get(pairKey(endpoint, playerId))!;
      return { endpoint: this.evidence.player(endpoint), evidenceCount: edge.evidenceCount, proof: edge.proof };
    };
    return { player: this.evidence.player(playerId), left: side(q.playerA), right: side(q.playerB) };
  }

  answer(id: string, version: string, playerId: string) {
    const q = this.checked(id, version);
    const player = this.evidence.player(playerId);
    const status = [q.playerA, q.playerB].includes(playerId) ? 'endpoint' :
      q.answerIds.includes(playerId) ? 'accepted' : 'not_confirmed';
    return { questionId: id, bankVersion: version, status, player,
      explanation: status === 'accepted' ? this.explanation(q, playerId) : null };
  }

  reveal(id: string, version: string) {
    const q = this.checked(id, version);
    return { questionId: id, bankVersion: version, coverage: 'partial' as const,
      answers: q.answerIds.map(playerId => this.explanation(q, playerId)) };
  }

  reviewExport() {
    const questions = [...this.bank.questions].sort((a, b) =>
      Number(a.endpointsHaveConfirmedEdge) - Number(b.endpointsHaveConfirmedEdge) || a.id.localeCompare(b.id));
    // Across-roster candidates first, then multi-answer cases; retain all answers of every sampled question.
    return { ...this.bank, summary: this.metadata(),
      reviewSample: questions.slice(0, 100).map(q => ({ ...q,
        endpoints: [this.evidence.player(q.playerA), this.evidence.player(q.playerB)],
        explanations: this.reveal(q.id, this.bank.bankVersion).answers })),
      acceptance: { automaticGraphConsistency: 'checked', sourceCoverageReview: 'pending',
        humanQuestionReview: 'pending', multiplayer: 'not_implemented' } };
  }
}
