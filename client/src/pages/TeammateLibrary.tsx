import { useEffect, useRef, useState } from 'react';
import { ExternalLink, GitBranch, Search, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import Page from '../components/Page';
import { api } from '../api/client';
import { CandidateMetadata, CandidatePlayer, CandidateRelationship, candidateError } from '../api/cslinkCandidates';
import CandidatePlayerPicker, { CandidateField, emptyCandidateField } from '../components/CsLinkCandidatePlayerPicker';
import styles from './Teammates.module.css';

export default function TeammateLibrary() {
  const [meta, setMeta] = useState<CandidateMetadata | null>(null);
  const [metaError, setMetaError] = useState('');
  const [metaAttempt, setMetaAttempt] = useState(0);
  const [a, setA] = useState<CandidateField>(emptyCandidateField);
  const [b, setB] = useState<CandidateField>(emptyCandidateField);
  const [result, setResult] = useState<CandidateRelationship | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof candidateError> | null>(null);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setMetaError('');
    void api.get<CandidateMetadata>('/cslink/candidates/meta', { signal: controller.signal })
      .then(({ data }) => { if (alive) setMeta(data); })
      .catch(err => { if (alive) setMetaError(candidateError(err).message); });
    return () => { alive = false; controller.abort(); };
  }, [metaAttempt]);
  useEffect(() => () => { generation.current++; pending.current?.abort(); }, []);

  const invalidate = () => {
    generation.current++;
    pending.current?.abort();
    setResult(null); setError(null); setBusy(false);
  };
  const lookup = async (left: CandidatePlayer, right: CandidatePlayer, offset = 0) => {
    if (!meta || left.id === right.id) return;
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    if (!offset) setResult(null);
    try {
      const { data } = await api.get<CandidateRelationship>('/cslink/candidates/relationship', {
        params: { playerA: left.id, playerB: right.id, version: meta.version, offset }, signal: controller.signal,
      });
      if (current !== generation.current) return;
      setResult(previous => offset && previous ? { ...data, evidence: [...previous.evidence, ...data.evidence] } : data);
    } catch (err) {
      if (current === generation.current) setError(candidateError(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return <Page title="候选关系库" className={styles.shell} icon={<GitBranch size={17} />}
    actions={<Link to="/teammates" className="btn btn-sm">综合关系查询</Link>}>
    <div className={styles.content}>
      <header className={styles.intro}>
        <div className={styles.masthead}><span className={styles.eyebrow}>CS LINK / MAP EVIDENCE</span><span className={styles.sectionIndex}>03 — 首轮候选库</span></div>
        <h1>从一张地图，找到一段关系。</h1>
        <p>按 HLTV 数字编号选择两名选手，查看候选 A/S 赛事首轮采样中同队出场的地图。名单由单图统计页提取，现阶段仍等待逐条复核。</p>
      </header>
      {metaError && <div className={styles.notice} role="alert">{metaError}
        <button className="btn btn-sm" onClick={() => setMetaAttempt(x => x + 1)}>重新加载数据</button>
      </div>}
      {!meta && !metaError && <p role="status">正在加载候选关系库…</p>}
      {meta && <>
        <div className={`${styles.coverage} ${styles.candidateCoverage}`}>
          <ShieldAlert size={18} aria-hidden="true" />
          <span>首轮样本 <strong>{meta.capturedMaps}</strong> 张地图 · <strong>{meta.distinctPlayers}</strong> 个数字选手身份 · <strong>{meta.candidatePairs}</strong> 对候选关系</span>
          <span>待复核 · 不用于正式题库</span>
        </div>
        <form className={styles.searchPanel} onSubmit={event => { event.preventDefault(); if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>
          <div className={styles.panelHeading}><span className={styles.serial}>01 / SELECT PLAYERS</span><span>昵称只用于搜索，身份以 HLTV 编号为准</span></div>
          <div className={styles.fields}>
            <CandidatePlayerPicker label="第一名选手" field={a} version={meta.version} onChange={field => { invalidate(); setA(field); }} />
            <GitBranch className={styles.connector} size={25} aria-hidden="true" />
            <CandidatePlayerPicker label="第二名选手" field={b} version={meta.version} onChange={field => { invalidate(); setB(field); }} />
          </div>
          {a.selected && a.selected.id === b.selected?.id && <p role="alert">请选择两名不同的选手。</p>}
          <div className={styles.actions}>
            <button className="btn btn-primary" type="submit" disabled={busy || !a.selected || !b.selected || a.selected.id === b.selected.id}>
              <Search size={16} />{busy ? '正在查询…' : '查询采样证据'}
            </button>
          </div>
        </form>
        {error && <div className={styles.notice} role="alert">{error.message}
          {error.code === 'CSLINK_CANDIDATE_VERSION_CHANGED' ? <button className="btn btn-sm" onClick={() => {
            invalidate(); setA(emptyCandidateField); setB(emptyCandidateField); setMeta(null); setMetaAttempt(x => x + 1);
          }}>更新数据版本</button> : <button className="btn btn-sm" disabled={busy || !a.selected || !b.selected}
            onClick={() => { if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>重试查询</button>}
        </div>}
        {result && <section className={styles.results} aria-label="候选关系查询结果" aria-live="polite">
          <div className={styles.resultHeading}>
            <div><span className={styles.serial}>02 / MAP EVIDENCE</span><h2>{result.playerA.nickname} <span>与</span> {result.playerB.nickname}</h2></div>
            <span className={styles.badge}>{result.total ? `${result.total} 张同队采样地图` : '首轮样本未找到'}</span>
          </div>
          {!result.total ? <div className={styles.empty}>
            <GitBranch size={32} />
            <h3>这 805 张首轮样本中，没有找到两人的同队地图。</h3>
            <p>这不能证明他们从未做过队友；同届其他地图与阵容变化仍需补查。</p>
          </div> : <>
            <p className={styles.hint}>以下地图的统计表将两人列在同一队；请打开 HLTV 单图页复核后再用于正式题目。</p>
            {result.evidence.map(item => <article key={item.mapId} className={styles.evidence}>
              <div className={styles.evidenceTop}>
                <div><span className={styles.evidenceIndex}>{item.dateRaw.slice(0, 10)} / MAP #{item.mapId} / {item.tier}</span><h3>{item.event}</h3></div>
                <a className="btn btn-sm" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">HLTV · {item.map}<ExternalLink size={14} /></a>
              </div>
              <div className={styles.match}><strong>{item.team} 同队出场</strong><span>{item.opponents[0]} {item.score.join(' : ')} {item.opponents[1]} · {item.map}</span></div>
              <div className={styles.lineup} aria-label={`${item.map} 同队名单`}>
                {item.lineup.map(player => <span key={player.id} className={[result.playerA.id, result.playerB.id].includes(player.id) ? styles.highlighted : undefined} title={`HLTV #${player.hltvId}`}>{player.nickname}</span>)}
              </div>
              <details className={styles.audit}>
                <summary>查看来源与待复核状态</summary>
                <dl><dt>对手五人</dt><dd>{item.opponentLineup.map(player => `${player.nickname} (#${player.hltvId})`).join('、')}</dd>
                  <dt>赛事范围来源</dt><dd><a href={item.eventUrl} target="_blank" rel="noopener noreferrer">赛事页面<ExternalLink size={12} /></a></dd>
                  <dt>出场审核</dt><dd>待人工复核；仅为候选关系</dd>
                  <dt>原始显示时间</dt><dd>{item.dateRaw}（时区尚未核定）</dd>
                  <dt>捕获指纹</dt><dd><code>{item.captureSha256}</code></dd>
                  <dt>数据版本</dt><dd><code>{result.version}</code></dd>
                </dl>
              </details>
            </article>)}
            {result.hasMore && <button className="btn" disabled={busy} onClick={() => void lookup(result.playerA, result.playerB, result.evidence.length)}>加载更多地图</button>}
          </>}
        </section>}
        {!result && !busy && !error && <div className={styles.startHint}><GitBranch size={25} /><p>先选择两个具体的 HLTV 选手编号。</p></div>}
        <footer className={styles.footnote}>
          <p>本库只包含按 A/S 标签选取的首轮采样地图，赛事范围尚待复核。候选关系已进入综合查询，但不会被标为已复核，也不会进入练习题库或多人对战结算。</p>
          <p>候选库版本：<code>{meta.version}</code></p>
        </footer>
      </>}
    </div>
  </Page>;
}
