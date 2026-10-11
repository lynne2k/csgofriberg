import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import { MergedPlayer, mergedError, playerIdentityLabel } from '../api/cslinkMerged';
import styles from '../pages/Teammates.module.css';

export interface MergedField { text: string; selected: MergedPlayer | null }
export const emptyMergedField: MergedField = { text: '', selected: null };

export default function MergedPlayerPicker({ label, field, onChange, version, searchPath = '/cslink/merged/players' }: {
  label: string; field: MergedField; onChange: (field: MergedField) => void; version: string; searchPath?: string;
}) {
  const [hits, setHits] = useState<MergedPlayer[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [retry, setRetry] = useState(0);
  const listId = `merged-${label}-options`;

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setHits([]); setTotal(0); setError(''); setActive(-1);
    if (field.selected || !field.text.trim()) { setBusy(false); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      void api.get<{ version: string; items: MergedPlayer[]; total: number }>(searchPath, {
        params: { search: field.text }, signal: controller.signal,
      }).then(({ data }) => {
        if (!alive) return;
        if (data.version !== version) { setError('数据版本已更新，请刷新页面。'); return; }
        setHits(data.items); setTotal(data.total);
      }).catch(err => { if (alive) setError(mergedError(err).message); })
        .finally(() => { if (alive) setBusy(false); });
    }, 180);
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [field.text, field.selected, version, retry, searchPath]);

  const pick = (player: MergedPlayer) => { setOpen(false); onChange({ text: player.nickname, selected: player }); };
  return <div className={styles.picker}>
    <label htmlFor={`merged-${label}`}>{label}</label>
    <input id={`merged-${label}`} role="combobox" aria-autocomplete="list"
      aria-expanded={open && !field.selected && Boolean(field.text.trim())}
      aria-controls={listId} aria-activedescendant={open && !field.selected && active >= 0 ? `${listId}-${active}` : undefined}
      aria-describedby={`${listId}-hint`} maxLength={100} autoComplete="off"
      placeholder="输入昵称或 HLTV 数字编号"
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
      {field.selected.hltvId && field.selected.profileUrl ? <a href={field.selected.profileUrl} target="_blank" rel="noopener noreferrer">
        {playerIdentityLabel(field.selected)} <ExternalLink size={12} />
      </a> : <span>{playerIdentityLabel(field.selected)}</span>}
      <small id={`${listId}-hint`}>已复核 {field.selected.verifiedMapCount} 张 · 采集 {field.selected.candidateMapCount} 张{field.selected.legacyMapCount ? ` · 旧库导入 ${field.selected.legacyMapCount} 张` : ''}</small>
    </div> : <p className={styles.hint} id={`${listId}-hint`}>从列表选择选手；同名时请留意编号或赛事。</p>}
    {open && !field.selected && field.text.trim() && <div className={styles.suggestions}>
      {busy && <p role="status">正在查找选手…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(x => x + 1)}>重试搜索</button></p>}
      {!busy && !error && !hits.length && <p role="status">当前关系库中没有匹配的选手。</p>}
      <ul role="listbox" id={listId} aria-label={`${label}候选`}>
        {hits.map((player, index) => <li key={player.id} role="presentation">
          <button id={`${listId}-${index}`} type="button" role="option" aria-selected={active === index}
            aria-label={`${player.nickname} · ${playerIdentityLabel(player)}`}
            onMouseDown={event => event.preventDefault()} onClick={() => pick(player)}>
            <strong>{player.nickname}</strong>
            <span>{playerIdentityLabel(player)}</span>
          </button>
        </li>)}
      </ul>
      {total > hits.length && <p className={styles.hint}>显示前 {hits.length} 项，共 {total} 项；继续输入可缩小范围。</p>}
    </div>}
  </div>;
}
