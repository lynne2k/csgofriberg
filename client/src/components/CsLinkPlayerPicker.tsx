import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import { EvidencePlayer, evidenceError } from '../api/cslink';
import styles from '../pages/Teammates.module.css';

export interface Field { text: string; selected: EvidencePlayer | null }
export const emptyField: Field = { text: '', selected: null };

export default function PlayerPicker({ label, field, onChange, version }: {
  label: string; field: Field; onChange: (field: Field) => void; version: string;
}) {
  const [hits, setHits] = useState<EvidencePlayer[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);
  const listId = `cslink-${label}-options`;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setHits([]); setTotal(0); setError(''); setActive(-1);
    if (field.selected || !field.text.trim()) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      void api.get<{ version: string; items: EvidencePlayer[]; total: number }>('/cslink/players', {
        params: { search: field.text }, signal: controller.signal,
      }).then(({ data }) => {
        if (!alive) return;
        if (data.version !== version) { setError('数据版本已更新，请刷新页面。'); return; }
        setHits(data.items); setTotal(data.total);
      }).catch(error => {
        if (alive) setError(evidenceError(error).message);
      }).finally(() => { if (alive) setBusy(false); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [field.text, field.selected, version, retry]);

  const pick = (player: EvidencePlayer) => { setOpen(false); onChange({ text: player.nickname, selected: player }); };
  return <div className={styles.picker}>
    <label htmlFor={`cslink-${label}`}>{label}</label>
    <input id={`cslink-${label}`} role="combobox" aria-autocomplete="list"
      aria-expanded={open && !field.selected && Boolean(field.text.trim())}
      aria-controls={listId} aria-activedescendant={open && !field.selected && active >= 0 ? `${listId}-${active}` : undefined}
      aria-describedby={`${listId}-hint`} maxLength={100} autoComplete="off"
      placeholder="输入昵称、姓名或 HLTV 编号"
      value={field.text} onFocus={() => setOpen(true)}
      onChange={event => { setOpen(true); setActive(-1); onChange({ text: event.target.value, selected: null }); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { setOpen(false); setActive(-1); }
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, hits.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(-1, index - 1)); }
        if (event.key === 'Enter' && !field.selected) {
          event.preventDefault();
          if (open && active >= 0 && hits[active]) pick(hits[active]);
        }
      }} />
    {field.selected ? <div className={styles.identity}>
      <strong>{field.selected.nickname}</strong>
      <span>{field.selected.name ?? '姓名未补充'}</span>
      <a href={field.selected.profileUrl} target="_blank" rel="noopener noreferrer">
        HLTV #{field.selected.hltvId} <ExternalLink size={12} />
      </a>
      <small id={`${listId}-hint`}>当前库有 {field.selected.verifiedMapCount} 张已核实出场地图</small>
    </div> : <p className={styles.hint} id={`${listId}-hint`}>请选择具体身份；相似昵称不会自动合并。</p>}
    {open && !field.selected && field.text.trim() && <div className={styles.suggestions}>
      {busy && <p role="status">正在查找选手…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(x => x + 1)}>重试搜索</button></p>}
      {!busy && !error && !hits.length && <p role="status">身份表中没有匹配项，可能尚未收录。</p>}
      <ul role="listbox" id={listId} aria-label={`${label}候选`}>
        {hits.map((player, index) => <li key={player.id} role="presentation">
          <button id={`${listId}-${index}`} type="button" role="option" aria-selected={active === index}
            aria-label={`${player.nickname} ${player.name ?? '姓名未补充'} · HLTV #${player.hltvId}`}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(player)}>
            <strong>{player.nickname}</strong>
            <span>{player.name ?? '姓名未补充'} · HLTV #{player.hltvId}</span>
          </button>
        </li>)}
      </ul>
      {total > hits.length && <p className={styles.hint}>显示前 {hits.length} 项，共 {total} 项；继续输入可缩小范围。</p>}
    </div>}
  </div>;
}

