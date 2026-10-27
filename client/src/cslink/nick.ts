/* CS Link 昵称：只存在本机 localStorage，提交成绩、建房、进房时带给服务端。
   规则和 server/src/services/cslinkNickname.ts 一致：2–12 个字，去掉控制字符和 <>"'`&\ 。
   昵称只改显示名，成绩和排名仍按访客身份归属。 */
import { api } from '../api/client';

const KEY = 'cslinkNickname';
const ASKED = 'cslinkNicknameAsked';

export function cleanNickname(raw: string): string | null {
  const text = raw.normalize('NFKC').replace(/[\p{C}<>"'`&\\]/gu, '').replace(/\s+/gu, ' ').trim();
  const length = [...text].length;
  return length >= 2 && length <= 12 ? text : null;
}

export function getNickname(): string | undefined {
  try { return cleanNickname(localStorage.getItem(KEY) ?? '') ?? undefined; } catch { return undefined; }
}

function save(name: string | null) {
  try {
    if (name) localStorage.setItem(KEY, name); else localStorage.removeItem(KEY);
    localStorage.setItem(ASKED, '1');
  } catch { /* 隐私模式写不进去就只在本页生效 */ }
  window.dispatchEvent(new Event('csnick'));
}

/** 服务端词库审核；网络出错时先放行，提交成绩时服务端还会再审一次 */
async function serverAllows(name: string): Promise<boolean> {
  try {
    const res = await api.post('/cslink/daily/nickname-check', { nickname: name });
    return res.data?.ok !== false;
  } catch { return true; }
}

const STYLE = `
.csnick-back{position:fixed;inset:0;z-index:200;display:grid;place-items:center;background:rgba(5,6,9,.62);backdrop-filter:blur(3px)}
.csnick{width:min(360px,calc(100vw - 32px));padding:22px 22px 18px;border-radius:14px;color:#2a1c10;
  background:linear-gradient(#f8f0de,#e3cfa6);box-shadow:inset 0 0 0 4px #f3ead6,inset 0 0 0 5px #8a6a3b,0 24px 60px rgba(0,0,0,.55);
  font-family:'Noto Sans SC',-apple-system,'PingFang SC',sans-serif}
.csnick h3{margin:0 0 4px;font-size:20px;font-weight:900}
.csnick p{margin:0 0 14px;font-size:13px;opacity:.7}
.csnick input{width:100%;box-sizing:border-box;padding:12px 14px;border:0;border-radius:8px;background:#fffaf0;color:#2a1c10;
  font:700 18px 'Noto Sans SC',sans-serif;box-shadow:inset 0 0 0 1.5px #b28d55}
.csnick input:focus{outline:none;box-shadow:inset 0 0 0 2px #f5a623,0 0 0 3px rgba(245,166,35,.25)}
.csnick .e{min-height:18px;margin:6px 2px 0;font-size:12px;color:#b3261e}
.csnick .b{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
.csnick button{border:0;border-radius:8px;padding:10px 18px;font:900 15px 'Noto Sans SC',sans-serif;cursor:pointer}
.csnick .ok{background:#0d0f14;color:#f5a623}.csnick .skip{background:transparent;color:#5a4428}
.csnick button:focus-visible{outline:3px solid #6f86ff;outline-offset:2px}`;

/** 弹窗问昵称。返回最终显示用的昵称（跳过时 undefined，服务端会用访客编号） */
export function askNickname(): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (!document.getElementById('csnick-style')) {
      const s = document.createElement('style'); s.id = 'csnick-style'; s.textContent = STYLE; document.head.appendChild(s);
    }
    const back = document.createElement('div');
    back.className = 'csnick-back';
    back.innerHTML = '<form class="csnick" role="dialog" aria-modal="true" aria-labelledby="csnick-t">' +
      '<h3 id="csnick-t">起个昵称</h3><p>排行榜和房间里显示这个名字，2–12 个字，之后还能改。</p>' +
      '<input maxlength="24" autocomplete="nickname" spellcheck="false" aria-label="昵称" />' +
      '<div class="e" role="alert"></div>' +
      '<div class="b"><button type="button" class="skip">先不起</button><button type="submit" class="ok">就叫这个</button></div></form>';
    const form = back.querySelector('form')!, input = back.querySelector('input')!, err = back.querySelector('.e')!;
    input.value = getNickname() ?? '';
    const prev = document.activeElement as HTMLElement | null;
    const close = (name: string | undefined) => { back.remove(); prev?.focus?.(); resolve(name); };
    let checking = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (checking) return;
      const name = cleanNickname(input.value);
      if (!name) { err.textContent = '2–12 个字，别用 < > " \' & 这类符号'; input.focus(); return; }
      checking = true; err.textContent = '';
      const ok = await serverAllows(name);
      checking = false;
      if (!ok) { err.textContent = '这个昵称不能用，换一个吧'; input.focus(); input.select(); return; }
      save(name); close(name);
    });
    back.querySelector('.skip')!.addEventListener('click', () => { save(getNickname() ?? null); close(getNickname()); });
    back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(getNickname()); } });
    document.body.appendChild(back);
    input.focus(); input.select();
  });
}

/** 第一次来才弹；问过一次（包括点了先不起）就不再打扰 */
export async function ensureNickname(): Promise<string | undefined> {
  let asked = false;
  try { asked = localStorage.getItem(ASKED) === '1'; } catch { asked = true; }
  return asked ? getNickname() : askNickname();
}

const nick = { get: getNickname, ask: askNickname, ensure: ensureNickname };
declare global { interface Window { CSNICK?: typeof nick } }
window.CSNICK = nick;
