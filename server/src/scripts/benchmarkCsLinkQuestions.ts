/** Deterministic sparse-graph parity and timing probe; no CS roster facts. */
import crypto from 'crypto';
import { performance } from 'perf_hooks';
import { buildCsLinkQuestionBank } from '../services/cslinkPlay';

const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = (id: string) => Number(id.slice(5));
const version = '0'.repeat(20);
const rules = { minAnswers: 1, maxAnswers: 3, excludeEndpoints: true,
  acceptAllCommonNeighbors: true, coverage: 'approved_as_tier_sample' };

function fixture(size: number) {
  const graph = new Map<string, Set<string>>();
  for (let i = 1; i <= size; i++) graph.set(`hltv:${i}`, new Set());
  const connect = (a: number, b: number) => {
    graph.get(`hltv:${a}`)!.add(`hltv:${b}`);
    graph.get(`hltv:${b}`)!.add(`hltv:${a}`);
  };
  for (let first = 1; first <= size; first += 5) {
    for (let a = first; a < Math.min(first + 5, size + 1); a++)
      for (let b = a + 1; b < Math.min(first + 5, size + 1); b++) connect(a, b);
    if (first > 1) connect(first - 1, first);
  }
  for (let a = 1; a <= Math.min(8, size); a++)
    for (let b = a + 1; b <= Math.min(8, size); b++) connect(a, b);
  return graph;
}

function exhaustive(graph: ReadonlyMap<string, ReadonlySet<string>>) {
  const ids = [...graph.keys()].sort((a, b) => numeric(a) - numeric(b));
  const questions = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = ids[i], b = ids[j];
    const answers = [...graph.get(a)!].filter(id => id !== b && graph.get(b)!.has(id))
      .sort((x, y) => numeric(x) - numeric(y));
    if (answers.length < rules.minAnswers || answers.length > rules.maxAnswers) continue;
    questions.push({ id: hash([version, rules, a, b]).slice(0, 20), a, b,
      answerIds: answers, direct: graph.get(a)!.has(b) });
  }
  return questions;
}

const small = fixture(2_000);
let start = performance.now();
const reference = exhaustive(small);
const exhaustiveMs = performance.now() - start;
start = performance.now();
const sparse = buildCsLinkQuestionBank(small, version);
const sparseMs = performance.now() - start;
if (JSON.stringify(reference) !== JSON.stringify(sparse.questions)) {
  throw new Error('Question bank differs from exhaustive reference');
}
const large = fixture(10_000);
start = performance.now();
const largeBank = buildCsLinkQuestionBank(large, version);
const largeMs = performance.now() - start;
console.log(JSON.stringify({ referenceNodes: small.size, referenceQuestions: reference.length,
  exhaustiveMs: Math.round(exhaustiveMs), sparseMs: Math.round(sparseMs),
  largeNodes: large.size, largeQuestions: largeBank.questions.length,
  largeSparseMs: Math.round(largeMs), sameQuestionsAndOrder: true }));
