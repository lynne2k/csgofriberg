import fs from 'node:fs';
import path from 'node:path';

/**
 * CS Link 昵称审核：本地词库（政治、色情、暴恐）+ 归一化。
 * 词库由 scripts/build_nick_lexicon.mjs 编译成 data/cslink/nick-lexicon.json。
 *
 * 归一化依次做：全角转半角、大小写、繁转简、去掉空格和符号、偏旁互通（糸 → 纟）、
 * 拆字合并（纟田 → 细）、数字字母混写（x1 → xi），最后按不带声调的读音再比一次（细井瓶 ≈ 习近平）。
 *
 * 结果：
 *   - block：字面命中（原文或拆字合并后），或英文/拼音缩写命中
 *   - suspect：只在读音上撞上三个字以上的敏感词。没有人工复核队列，处理方式和 block 一样：不显示
 */
export type CsLinkNickVerdict = { ok: true } | { ok: false; level: 'block' | 'suspect'; term: string };

interface Lexicon {
  alias: Record<string, string>; ts: Record<string, string>; merge: Record<string, string>;
  text: string[]; latin: string[]; pinyin: string[]; pyStart: number; py: string;
}
interface Compiled {
  alias: Record<string, string>; ts: Record<string, string>; merge: Record<string, string>;
  text: Set<string>; latin: Set<string>; pinyin: Set<string>; pinyinFlat: Set<string>;
  pyStart: number; py: string[]; maxText: number; maxLatin: number; maxPinyin: number;
}

const DEFAULT_FILE = path.resolve(__dirname, '../../../data/cslink/nick-lexicon.json');
let compiled: Compiled | null | undefined;

const fuzzy = (s: string) => s.replace(/ing/g, 'in').replace(/eng/g, 'en').replace(/ang/g, 'an')
  .replace(/zh/g, 'z').replace(/ch/g, 'c').replace(/sh/g, 's');
const leet = (s: string) => s.replace(/[1l|!]/g, 'i').replace(/0/g, 'o').replace(/3/g, 'e')
  .replace(/4|@/g, 'a').replace(/5|\$/g, 's').replace(/7/g, 't');

export function loadCsLinkNickLexicon(file = process.env.CSLINK_NICK_LEXICON || DEFAULT_FILE): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Lexicon;
    const pinyin = new Set(raw.pinyin);
    compiled = {
      alias: raw.alias, ts: raw.ts, merge: raw.merge,
      text: new Set(raw.text), latin: new Set(raw.latin), pinyin,
      pinyinFlat: new Set([...pinyin].map((t) => leet(t.replace(/\|/g, '')))),
      pyStart: raw.pyStart, py: raw.py.split(','),
      maxText: Math.max(0, ...raw.text.map((t) => [...t].length)),
      maxLatin: Math.max(0, ...raw.latin.map((t) => t.length)),
      maxPinyin: Math.max(0, ...raw.pinyin.map((t) => t.split('|').length)),
    };
    return true;
  } catch (error) {
    // 热更新失败保留上一次成功加载的词库。首次加载失败才降级并报错。
    console.error('[cslink:nick-lexicon] load failed; keeping previous lexicon', (error as Error).message);
    if (compiled === undefined) compiled = null;
    return false;
  }
}

function lexicon(): Compiled | null {
  if (compiled === undefined) loadCsLinkNickLexicon();
  return compiled ?? null;
}

/** 在 chars 的所有连续片段里找词（昵称最长 12 个字，片段数很少） */
function hit(chars: string[], set: Set<string>, max: number, join = ''): string | null {
  for (let i = 0; i < chars.length; i++) {
    for (let n = 1; n <= max && i + n <= chars.length; n++) {
      const piece = chars.slice(i, i + n).join(join);
      if (set.has(piece)) return piece;
    }
  }
  return null;
}

export function moderateCsLinkNickname(name: string): CsLinkNickVerdict {
  const lex = lexicon();
  if (!lex) return { ok: true };
  const folded = [...name.normalize('NFKC').toLowerCase()].map((c) => lex.ts[c] || c);
  const chars = folded.filter((c) => /[\p{L}\p{N}]/u.test(c));

  // 拆字合并：先把偏旁换成统一写法，再贪心地三字、两字合并
  const parts = chars.map((c) => lex.alias[c] || c);
  const merged: string[] = [];
  for (let i = 0; i < parts.length;) {
    const three = parts.slice(i, i + 3).join(''), two = parts.slice(i, i + 2).join('');
    if (i + 3 <= parts.length && lex.merge[three]) { merged.push(lex.merge[three]); i += 3; }
    else if (i + 2 <= parts.length && lex.merge[two]) { merged.push(lex.merge[two]); i += 2; }
    else { merged.push(chars[i]); i += 1; }
  }

  for (const seq of [chars, merged]) {
    const term = hit(seq, lex.text, lex.maxText);
    if (term) return { ok: false, level: 'block', term };
  }

  // 英文和拼音缩写：只看字母数字部分，数字当字母读（x1jinp1ng）
  const latin = leet(chars.filter((c) => /[a-z0-9|!@$]/.test(c)).join(''));
  if (latin.length >= 3) {
    const term = hit([...latin], lex.latin, lex.maxLatin);
    if (term) return { ok: false, level: 'block', term };
  }

  // 按读音：汉字转拼音，和三个字以上的敏感词比；字母部分直接当拼音串比
  for (const seq of [chars, merged]) {
    const syllables = seq.map((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= lex.pyStart && cp - lex.pyStart < lex.py.length ? fuzzy(lex.py[cp - lex.pyStart]) : c;
    });
    const term = hit(syllables, lex.pinyin, lex.maxPinyin, '|');
    if (term && term.includes('|')) return { ok: false, level: 'suspect', term };
  }
  const flat = fuzzy(latin);
  for (const term of lex.pinyinFlat) {
    if (term.length >= 6 && flat.includes(term)) return { ok: false, level: 'suspect', term };
  }
  return { ok: true };
}
