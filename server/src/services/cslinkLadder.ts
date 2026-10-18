import fs from 'fs';
import path from 'path';

export interface CsLinkLadderEntry { key: string; name: string; rating: number; wins: number; losses: number; draws: number; updatedAt: number }
export interface CsLinkLadderSide { key: string; name: string }

export const CSLINK_LADDER_START = 1000;
export const CSLINK_LADDER_K = 32;

/** Expected score of a against b under Elo. */
export function eloExpected(ra: number, rb: number) { return 1 / (1 + 10 ** ((rb - ra) / 400)); }

/**
 * 天梯分：按身份 key 存（访客 g:xxx，登录用户 u:id），玩家只看到一个分数。
 * 单进程内存 + JSON 文件落盘；file 为空时只在内存里（测试用）。
 */
export class CsLinkLadder {
  private entries = new Map<string, CsLinkLadderEntry>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file: string | null = null, private now: () => number = Date.now) {
    if (!file) return;
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as CsLinkLadderEntry[];
      for (const row of rows) if (row && typeof row.key === 'string' && Number.isFinite(row.rating)) this.entries.set(row.key, row);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[cslink] 天梯分读取失败，从空表开始', error);
    }
  }

  rating(key: string) { return this.entries.get(key)?.rating ?? CSLINK_LADDER_START; }

  /** a vs b，scoreA 取 1 / 0.5 / 0。返回双方分数变化。 */
  settle(a: CsLinkLadderSide, b: CsLinkLadderSide, scoreA: 0 | 0.5 | 1): Record<string, number> {
    const ea = this.entry(a), eb = this.entry(b);
    const delta = Math.round(CSLINK_LADDER_K * (scoreA - eloExpected(ea.rating, eb.rating)));
    ea.rating += delta; eb.rating -= delta;
    if (scoreA === 1) { ea.wins++; eb.losses++; } else if (scoreA === 0) { ea.losses++; eb.wins++; } else { ea.draws++; eb.draws++; }
    ea.updatedAt = eb.updatedAt = this.now();
    this.scheduleSave();
    return { [a.key]: delta, [b.key]: -delta };
  }

  top(limit = 10) {
    return [...this.entries.values()].sort((x, y) => y.rating - x.rating || x.updatedAt - y.updatedAt).slice(0, limit)
      .map((row, index) => ({ rank: index + 1, name: row.name, rating: row.rating, games: row.wins + row.losses + row.draws }));
  }

  /** 玩家自己的分数和名次（没打过天梯时 rank 为 null）。 */
  standing(key: string) {
    const me = this.entries.get(key);
    if (!me) return { rating: CSLINK_LADDER_START, rank: null as number | null, games: 0 };
    const rank = 1 + [...this.entries.values()].filter(row => row.rating > me.rating).length;
    return { rating: me.rating, rank, games: me.wins + me.losses + me.draws };
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.entries.values()]));
    fs.renameSync(tmp, this.file);
  }

  private entry(side: CsLinkLadderSide) {
    let row = this.entries.get(side.key);
    if (!row) { row = { key: side.key, name: side.name, rating: CSLINK_LADDER_START, wins: 0, losses: 0, draws: 0, updatedAt: this.now() }; this.entries.set(side.key, row); }
    row.name = side.name;
    return row;
  }
  private scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { try { this.flush(); } catch (error) { console.error('[cslink] 天梯分写入失败', error); } }, 2_000);
    this.saveTimer.unref?.();
  }
}
