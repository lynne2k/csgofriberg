#!/usr/bin/env node
/* 编译 CS Link 昵称审核词库：data/cslink/nick-lexicon.json
 *
 * 输入目录（默认 .local-data/nick-lexicon-raw，不进仓库）里放：
 *   - konsheng/Sensitive-lexicon 的 Vocabulary/*.txt（MIT）
 *   - kfcd/chaizi 的 chaizi-jt.txt（CC BY 3.0，拆字表）
 *   - BYVoid/OpenCC 的 TSCharacters.txt（Apache-2.0，繁转简字表）
 * 拼音用 pinyin-pro（MIT），装在 .local-tools/nick：
 *   npm i --prefix .local-tools/nick pinyin-pro@3.29.5
 *
 * 用法：node scripts/build_nick_lexicon.mjs [rawDir]
 * 运行时的归一化在 server/src/services/cslinkNickModeration.ts，两边规则要一致。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = path.resolve(process.argv[2] || path.join(root, '.local-data/nick-lexicon-raw'));
const require = createRequire(path.join(root, '.local-tools/nick/package.json'));
const { pinyin } = require('pinyin-pro');

// 只用政治、色情、暴恐几类；涉枪涉爆会误伤 CS 昵称（炸弹、AK），不收
const FILES = ['政治类型', '反动词库', 'GFW补充词库', '色情类型', '色情词库', '暴恐词库'];
// 词库里会误伤正常昵称的条目（广告、彩票、过于常见的词），由 test_nick_moderation 的误伤结果整理
const DROP = new Set(JSON.parse(fs.readFileSync(path.join(root, 'data/cslink/nick-lexicon-allow.json'), 'utf8')).drop);
// 词库没收、但排行榜上实际会出现的说法
const EXTRA = ['维尼', '小熊维尼', '维尼熊', '习包子', '庆丰帝', '包子帝', '刁近平', '细近平', '习进平', '席近平'];

// 偏旁和独立字互通：糸田 → 细 和 纟田 → 细 都要认
const ALIAS = { '糸': '纟', '氵': '水', '亻': '人', '扌': '手', '讠': '言', '钅': '金', '忄': '心', '犭': '犬',
  '礻': '示', '衤': '衣', '饣': '食', '刂': '刀', '灬': '火', '艸': '艹', '⺮': '竹' };

const ts = {};
for (const line of fs.readFileSync(path.join(raw, 'TSCharacters.txt'), 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [t, s] = line.split('\t');
  if (t && s && [...t].length === 1) ts[t] = s.split(' ')[0];
}

const fold = (s) => [...s.normalize('NFKC').toLowerCase()].map((c) => ts[c] || c).join('');
const clean = (s) => fold(s).replace(/[^\p{L}\p{N}]/gu, '');
const isLatin = (s) => /^[a-z0-9]+$/.test(s);
const leet = (s) => s.replace(/[1l|!]/g, 'i').replace(/0/g, 'o').replace(/3/g, 'e').replace(/4|@/g, 'a').replace(/5|\$/g, 's').replace(/7/g, 't');

const terms = new Set();
for (const name of FILES) {
  for (const line of fs.readFileSync(path.join(raw, name + '.txt'), 'utf8').split(/\r?\n/)) {
    const t = clean(line);
    if (!t || DROP.has(t)) continue;
    if (/^\d+$/.test(t) && t.length < 4) continue;          // 20、64 这类纯数字太泛
    // 词库里的英文条目大多是网址、药名和 taiwan/youtube 这类普通词，拿来审昵称误伤太多；英文只用下面的 LATIN
    if (isLatin(t)) continue;
    if (!isLatin(t) && [...t].length < 2 && !/[屄肏]/.test(t)) continue;   // 单字只留明确的脏字
    terms.add(t);
  }
}
EXTRA.forEach((t) => terms.add(clean(t)));
// 英文和拼音缩写：手工挑的。完整拼音（xijinping）走下面的读音比对，这里不用重复
// flg 不收：数字字母混写会把 l 当 i，flg 和 config 里的 fig 撞上
const LATIN = ['xjp', 'jzm', 'hjt', 'gcd', 'ccp', 'falun', 'falungong', 'dajiyuan', 'minghui', 'tuidang',
  'tiananmen', 'fuck', 'porn', 'sexinsex', 'incest', 'nigger', 'nigga'];
LATIN.forEach((t) => terms.add(t));

// 每个汉字一个不带声调的读音，按码位存（4E00–9FFF）
const PY_START = 0x4e00, PY_END = 0x9fff;
const py = [];
for (let cp = PY_START; cp <= PY_END; cp++) py.push(pinyin(String.fromCodePoint(cp), { toneType: 'none', type: 'array' })[0] || '');
const pyOf = (c) => { const cp = c.codePointAt(0); return cp >= PY_START && cp <= PY_END ? py[cp - PY_START] : null; };
// 模糊音：前后鼻音、平翘舌不分
const fuzzy = (s) => s.replace(/ing/g, 'in').replace(/eng/g, 'en').replace(/ang/g, 'an').replace(/zh/g, 'z').replace(/ch/g, 'c').replace(/sh/g, 's');

const textTerms = [], latinTerms = [], pinyinTerms = new Set();
const usedChars = new Set();
for (const t of terms) {
  if (isLatin(t)) { latinTerms.push(leet(t)); continue; }
  textTerms.push(t);
  [...t].forEach((c) => usedChars.add(c));
  const chars = [...t];
  // 三个字以上的纯汉字词才按读音比，两个字的同音词太多
  if (chars.length >= 3 && chars.every(pyOf)) pinyinTerms.add(chars.map((c) => fuzzy(pyOf(c))).join('|'));
}

// 拆字合并表：拆开写的字（糸田 → 细）合回去。读音比对也要用，所以收全部常用字
const merge = {};
for (const line of fs.readFileSync(path.join(raw, 'chaizi-jt.txt'), 'utf8').split('\n')) {
  const [ch, ...ways] = line.split('\t');
  if (!ch || !pyOf(ch)) continue;
  for (const way of ways) {
    const parts = way.trim().split(/\s+/).map((p) => ALIAS[p] || p);
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => [...p].length !== 1)) continue;
    const key = parts.join('');
    if (!merge[key]) merge[key] = ch;
  }
}

const out = {
  version: new Date().toISOString().slice(0, 10),
  sources: [
    'Sensitive-lexicon © Konsheng, MIT License, https://github.com/konsheng/Sensitive-lexicon',
    'chaizi 漢語拆字字典 © kfcd, CC BY 3.0, https://github.com/kfcd/chaizi (only the merge table derived from it)',
    'OpenCC TSCharacters © BYVoid, Apache-2.0, https://github.com/BYVoid/OpenCC',
    'pinyin-pro, MIT License, https://github.com/zh-lx/pinyin-pro (readings precomputed)',
  ],
  alias: ALIAS, ts, merge,
  text: textTerms.sort(), latin: [...new Set(latinTerms)].sort(), pinyin: [...pinyinTerms].sort(),
  pyStart: PY_START, py: py.join(','),
};
const dest = path.join(root, 'data/cslink/nick-lexicon.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(JSON.stringify({ text: out.text.length, latin: out.latin.length, pinyin: out.pinyin.length,
  merge: Object.keys(merge).length, ts: Object.keys(ts).length, bytes: fs.statSync(dest).size }));
