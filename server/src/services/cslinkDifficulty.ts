/**
 * 题目难度：两端选手的热度（出场图数排名）+ 两人之间的最少跳数。
 * 热度排名只在“能当题目两端”的选手里算（有定妆照、2024 起还在 S/A 出场）。
 * 中间人不受限，任何身份都能用来连。
 */
export const CSLINK_DIFFICULTIES = {
  easy: { label: '简单', topN: 60, minJumps: 2, maxJumps: 2 },
  normal: { label: '普通', topN: 150, minJumps: 3, maxJumps: 3 },
  hard: { label: '困难', topN: 400, minJumps: 3, maxJumps: 4 },
  hell: { label: '地狱', topN: Number.POSITIVE_INFINITY, minJumps: 4, maxJumps: 6 },
} as const;
export type CsLinkDifficulty = keyof typeof CSLINK_DIFFICULTIES;
export const CSLINK_DIFFICULTY_KEYS = Object.keys(CSLINK_DIFFICULTIES) as [CsLinkDifficulty, ...CsLinkDifficulty[]];
export const DEFAULT_CSLINK_DIFFICULTY: CsLinkDifficulty = 'normal';

export function isCsLinkDifficulty(value: unknown): value is CsLinkDifficulty {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CSLINK_DIFFICULTIES, value);
}

export type CsLinkDifficultyFilters = Record<CsLinkDifficulty, (id: string) => boolean>;

/** 按出场图数从多到少排名，同图数按 ID 排，保证同一份数据每次结果一样 */
export function buildCsLinkDifficultyFilters(ids: Iterable<string>, endpointAllowed: (id: string) => boolean,
  mapCount: (id: string) => number): { filters: CsLinkDifficultyFilters; ranked: string[] } {
  const ranked = [...new Set(ids)].filter(endpointAllowed)
    .sort((a, b) => mapCount(b) - mapCount(a) || (a < b ? -1 : a > b ? 1 : 0));
  const rank = new Map(ranked.map((id, i) => [id, i] as const));
  const filters = {} as CsLinkDifficultyFilters;
  for (const key of CSLINK_DIFFICULTY_KEYS) {
    const topN = CSLINK_DIFFICULTIES[key].topN;
    filters[key] = (id: string) => { const r = rank.get(id); return r !== undefined && r < topN; };
  }
  return { filters, ranked };
}
