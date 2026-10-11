import { useEffect, useRef, useState } from 'react';
import { ExternalLink, GitBranch, Search, ShieldCheck } from 'lucide-react';
import Page from '../components/Page';
import { api } from '../api/client';
import { EvidenceMetadata, EvidencePlayer, RelationshipResult, evidenceError } from '../api/cslink';
import styles from './Teammates.module.css';
import PlayerPicker, { Field, emptyField } from '../components/CsLinkPlayerPicker';
import { Link } from 'react-router-dom';

export default function Teammates() {
  const [meta, setMeta] = useState<EvidenceMetadata | null>(null);
  const [metaAttempt, setMetaAttempt] = useState(0);
  const [metaError, setMetaError] = useState('');
  const [a, setA] = useState<Field>(emptyField), [b, setB] = useState<Field>(emptyField);
  const [result, setResult] = useState<RelationshipResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof evidenceError> | null>(null);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setMetaError('');
    void api.get<EvidenceMetadata>('/cslink/meta', { signal: controller.signal })
      .then(({ data }) => { if (alive) setMeta(data); })
      .catch(error => { if (alive) setMetaError(evidenceError(error).message); });
    return () => { alive = false; controller.abort(); };
  }, [metaAttempt]);
  useEffect(() => () => { generation.current++; pending.current?.abort(); }, []);

  const invalidate = () => {
    generation.current++;
    pending.current?.abort();
    setResult(null); setError(null); setBusy(false);
  };
  const lookup = async (left: EvidencePlayer, right: EvidencePlayer, offset = 0) => {
    if (!meta || left.id === right.id) return;
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    if (!offset) setResult(null);
    try {
      const { data } = await api.get<RelationshipResult>('/cslink/relationship', {
        params: { playerA: left.id, playerB: right.id, version: meta.version, offset }, signal: controller.signal,
      });
      if (current !== generation.current) return;
      setResult(previous => offset && previous ? { ...data, evidence: [...previous.evidence, ...data.evidence] } : data);
    } catch (error) {
      if (current === generation.current) setError(evidenceError(error));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return <Page title="已复核旧样本" className={styles.shell} icon={<GitBranch size={17} />} actions={<><Link className="btn btn-sm" to="/teammates">综合关系查询</Link><Link className="btn btn-sm" to="/teammates/practice/legacy">旧样本练习</Link></>}>
    <div className={styles.content}>
      <header className={styles.intro}>
        <div className={styles.masthead}><span className={styles.eyebrow}>CS LINK / ROSTER ARCHIVE</span><span className={styles.sectionIndex}>01 — 队友档案</span></div>
        <h1>他们曾经并肩作战吗？</h1>
        <p>选择两名选手，查看已核实的同队出场记录。每条记录都能打开对应的 HLTV 地图统计页。</p>
      </header>
      {metaError && <div className={styles.notice} role="alert">{metaError}
        <button className="btn btn-sm" onClick={() => setMetaAttempt(x => x + 1)}>重新加载数据</button>
      </div>}
      {!meta && !metaError && <p role="status">正在加载复核数据…</p>}
      {meta && <>
        <div className={styles.coverage}>
          <ShieldCheck size={18} aria-hidden="true" />
          <span>当前收录 <strong>{meta.verifiedMaps}</strong> 张已核实地图 · <strong>{meta.registeredPlayers}</strong> 名已登记选手</span>
          <span>开发样本，A/S 范围尚未验收</span>
        </div>
        <form className={styles.searchPanel} onSubmit={event => { event.preventDefault(); if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>
          <div className={styles.panelHeading}><span className={styles.serial}>01 / SELECT PLAYERS</span><span>用选手编号确认具体身份</span></div>
          <div className={styles.fields}>
            <PlayerPicker label="第一名选手" field={a} version={meta.version} onChange={field => { invalidate(); setA(field); }} />
            <GitBranch className={styles.connector} size={25} aria-hidden="true" />
            <PlayerPicker label="第二名选手" field={b} version={meta.version} onChange={field => { invalidate(); setB(field); }} />
          </div>
          {a.selected && a.selected.id === b.selected?.id && <p role="alert">请选择两名不同的选手。</p>}
          <div className={styles.actions}>
            <button className="btn btn-primary" type="submit" disabled={busy || !a.selected || !b.selected || a.selected.id === b.selected.id}>
              <Search size={16} />{busy ? '正在查询…' : '查询同队证据'}
            </button>
            {meta.example && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
              const [left, right] = meta.example!;
              setA({ text: left.nickname, selected: left }); setB({ text: right.nickname, selected: right });
              void lookup(left, right);
            }}>试试 {meta.example[0].nickname} + {meta.example[1].nickname}</button>}
          </div>
        </form>
        {error && <div className={styles.notice} role="alert">{error.message}
          {error.code === 'CSLINK_VERSION_CHANGED' ? <button className="btn btn-sm" onClick={() => {
            invalidate(); setA(emptyField); setB(emptyField); setMeta(null); setMetaAttempt(x => x + 1);
          }}>更新数据版本</button> : <button className="btn btn-sm" disabled={busy || !a.selected || !b.selected}
            onClick={() => { if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>重试查询</button>}
        </div>}
        {result && <section className={styles.results} aria-label="关系查询结果" aria-live="polite">
          <div className={styles.resultHeading}>
            <div><span className={styles.serial}>02 / EVIDENCE</span><h2>{result.playerA.nickname} <span>与</span> {result.playerB.nickname}</h2></div>
            <span className={styles.badge}>{result.total ? `${result.total} 条单图证据` : '当前库未找到证据'}</span>
          </div>
          {!result.total ? <div className={styles.empty}>
            <GitBranch size={32} />
            <h3>当前已复核数据中，尚未找到两人的同队出场记录。</h3>
            <p>这不代表他们从未做过队友。历史比赛和选手身份仍在补充。</p>
          </div> : <>
            <p className={styles.hint}>以下地图中，两人出现在同一队的全场名单里。同一系列赛的不同地图分别保留证据。</p>
            {result.evidence.map(item => <article key={item.mapId} className={styles.evidence}>
              <div className={styles.evidenceTop}>
                <div><span className={styles.evidenceIndex}>{item.dateRaw.slice(0, 10)} / MAP #{item.mapId}</span><h3>{item.event}</h3></div>
                <a className="btn btn-sm" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">HLTV · {item.map}<ExternalLink size={14} /></a>
              </div>
              <div className={styles.match}><strong>{item.team} 同队出场</strong><span>{item.opponents[0]} {item.score.join(' : ')} {item.opponents[1]} · {item.map}</span></div>
              <div className={styles.lineup} aria-label={`${item.map} 同队名单`}>
                {item.lineup.map(player => <span key={player.id} className={[result.playerA.id, result.playerB.id].includes(player.id) ? styles.highlighted : undefined}>{player.nickname}</span>)}
              </div>
              <details className={styles.audit}>
                <summary>查看复核记录</summary>
                <dl><dt>原始时间</dt><dd>{item.dateRaw}（原数据未注明时区）</dd>
                  <dt>来源复核</dt><dd>{item.review.reviewedOn} · {item.review.reviewedBy === 'assistant' ? '助手逐页核对' : item.review.reviewedBy}</dd>
                  <dt>数据版本</dt><dd><code>{result.version}</code></dd>
                  <dt>记录指纹</dt><dd><code>{item.recordSha256}</code></dd>
                  <dt>原始记录位置</dt><dd>{Object.values(item.sourceRefs).flat().map((ref, i) => <div key={i}>{ref.file} · CSV 记录 {ref.csv_record}</div>)}</dd>
                </dl>
              </details>
            </article>)}
            {result.hasMore && <button className="btn" disabled={busy} onClick={() => void lookup(result.playerA, result.playerB, result.evidence.length)}>加载更多证据</button>}
          </>}
        </section>}
        {!result && !busy && !error && <div className={styles.startHint}><GitBranch size={25} /><p>每条队友关系，都从一张真实出场名单开始。</p></div>}
        <footer className={styles.footnote}>
          <p>本页仅展示已核实的正式比赛同队出场。当前开发样本仍含 A/S 范围外赛事；表演赛及待复核记录不计入。</p>
          <p>日期沿用原始数据，来源页面可能因显示时区不同而跨日。数据版本：<code>{meta.version}</code></p>
        </footer>
      </>}
    </div>
  </Page>;
}
