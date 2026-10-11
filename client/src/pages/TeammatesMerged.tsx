import { Fragment, useEffect, useRef, useState } from 'react';
import { ExternalLink, GitBranch, Search, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import Page from '../components/Page';
import { api } from '../api/client';
import { MergedMetadata, MergedPlayer, MergedRelationship, mergedError, playerIdentityLabel } from '../api/cslinkMerged';
import MergedPlayerPicker, { MergedField, emptyMergedField } from '../components/CsLinkMergedPlayerPicker';
import styles from './Teammates.module.css';

export default function TeammatesMerged() {
  const [meta, setMeta] = useState<MergedMetadata | null>(null);
  const [metaAttempt, setMetaAttempt] = useState(0);
  const [metaError, setMetaError] = useState('');
  const [a, setA] = useState<MergedField>(emptyMergedField);
  const [b, setB] = useState<MergedField>(emptyMergedField);
  const [result, setResult] = useState<MergedRelationship | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof mergedError> | null>(null);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setMetaError('');
    void api.get<MergedMetadata>('/cslink/merged/meta', { signal: controller.signal })
      .then(({ data }) => { if (alive) setMeta(data); })
      .catch(err => { if (alive) setMetaError(mergedError(err).message); });
    return () => { alive = false; controller.abort(); };
  }, [metaAttempt]);
  useEffect(() => () => { generation.current++; pending.current?.abort(); }, []);

  const invalidate = () => {
    generation.current++;
    pending.current?.abort();
    setResult(null); setError(null); setBusy(false);
  };
  const lookup = async (left: MergedPlayer, right: MergedPlayer, offset = 0) => {
    if (!meta || left.id === right.id) return;
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null);
    if (!offset) setResult(null);
    try {
      const { data } = await api.get<MergedRelationship>('/cslink/merged/relationship', {
        params: { playerA: left.id, playerB: right.id, version: meta.version, offset }, signal: controller.signal,
      });
      if (current !== generation.current) return;
      setResult(previous => offset && previous ? { ...data, evidence: [...previous.evidence, ...data.evidence] } : data);
    } catch (err) {
      if (current === generation.current) setError(mergedError(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };

  return <Page title="队友关系" className={styles.shell} icon={<GitBranch size={17} />}
    actions={<><Link className="btn btn-sm" to="/teammates/reviewed">已复核旧样本</Link>
      <Link className="btn btn-sm" to="/teammates/library">A/S 首图候选</Link>
      <Link className="btn btn-sm" to="/teammates/practice">共同队友练习</Link></>}>
    <div className={styles.content}>
      <header className={styles.intro}>
        <div className={styles.masthead}><span className={styles.eyebrow}>CS LINK / ROSTER ARCHIVE</span><span className={styles.sectionIndex}>01 — 综合关系查询</span></div>
        <h1>他们曾经并肩作战吗？</h1>
        <p>查询旧数据库与后续采集比赛中的队友关系。每条记录都有同队名单和对应的 HLTV 比赛链接。</p>
      </header>
      {metaError && <div className={styles.notice} role="alert">{metaError}
        <button className="btn btn-sm" onClick={() => setMetaAttempt(x => x + 1)}>重新加载数据</button>
      </div>}
      {!meta && !metaError && <p role="status">正在加载综合关系库…</p>}
      {meta && <>
        <div className={`${styles.coverage} ${styles.candidateCoverage}`}>
          <ShieldAlert size={18} aria-hidden="true" />
          <span><strong>{meta.verifiedMaps}</strong> 张已复核地图 · <strong>{meta.sampledMaps - (meta.legacyImportedMaps ?? 0)}</strong> 张采集地图{meta.legacyImportedMaps ? <> · <strong>{meta.legacyImportedMaps}</strong> 张旧库导入地图</> : null} · <strong>{meta.distinctPlayers}</strong> 个选手身份 · <strong>{meta.distinctPairs}</strong> 对队友关系</span>
          <span>每段关系均保留比赛来源</span>
        </div>
        {(!meta.sourceAvailability.verified || !meta.sourceAvailability.candidate) &&
          <div className={styles.notice} role="status">部分数据源暂未加载：{!meta.sourceAvailability.verified ? '旧复核样本' : 'A/S 首图候选'}。当前查询仅覆盖已加载的地图。</div>}
        <form className={styles.searchPanel} onSubmit={event => { event.preventDefault(); if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>
          <div className={styles.panelHeading}><span className={styles.serial}>01 / SELECT PLAYERS</span><span>同名时请留意选手编号或赛事</span></div>
          <div className={styles.fields}>
            <MergedPlayerPicker label="第一名选手" field={a} version={meta.version} onChange={field => { invalidate(); setA(field); }} />
            <GitBranch className={styles.connector} size={25} aria-hidden="true" />
            <MergedPlayerPicker label="第二名选手" field={b} version={meta.version} onChange={field => { invalidate(); setB(field); }} />
          </div>
          {a.selected && a.selected.id === b.selected?.id && <p role="alert">请选择两名不同的选手。</p>}
          <div className={styles.actions}>
            <button className="btn btn-primary" type="submit" disabled={busy || !a.selected || !b.selected || a.selected.id === b.selected.id}>
              <Search size={16} />{busy ? '正在查询…' : '查询同队地图'}
            </button>
            {meta.example && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => {
              const [left, right] = meta.example!;
              setA({ text: left.nickname, selected: left }); setB({ text: right.nickname, selected: right });
              void lookup(left, right);
            }}>试试 {meta.example[0].nickname} + {meta.example[1].nickname}</button>}
          </div>
        </form>
        {error && <div className={styles.notice} role="alert">{error.message}
          {error.code === 'CSLINK_MERGED_VERSION_CHANGED' ? <button className="btn btn-sm" onClick={() => {
            invalidate(); setA(emptyMergedField); setB(emptyMergedField); setMeta(null); setMetaAttempt(x => x + 1);
          }}>更新数据版本</button> : <button className="btn btn-sm" disabled={busy || !a.selected || !b.selected}
            onClick={() => { if (a.selected && b.selected) void lookup(a.selected, b.selected); }}>重试查询</button>}
        </div>}
        {result && <section className={styles.results} aria-label="综合关系查询结果" aria-live="polite">
          <div className={styles.resultHeading}>
            <div><span className={styles.serial}>02 / MAP EVIDENCE</span><h2>{result.playerA.nickname} <span>与</span> {result.playerB.nickname}</h2></div>
            <span className={styles.badge}>{result.total ? `${result.total} 张同队地图` : '当前样本未找到'}</span>
          </div>
          {!result.total ? <div className={styles.empty}>
            <GitBranch size={32} />
            <h3>当前已加载的地图中，没有找到两人的同队证据。</h3>
            <p>这不能证明他们从未做过队友；当前只收录部分赛事地图，历史覆盖仍不完整。</p>
          </div> : <>
            <p className={styles.hint}>以下地图记录了两人的同队出场。旧库导入沿用原有名单和比赛链接，没有逐图重新抓取。</p>
            {result.evidence.map(item => <article key={`${item.sourceDataset}-${item.mapId}`} className={styles.evidence}>
              <div className={styles.evidenceTop}>
                <div><span className={styles.evidenceIndex}>{item.dateRaw.slice(0, 10)} / MAP #{item.mapId}{item.tier ? ` / ${item.tier}` : ''}</span><h3>{item.event}</h3></div>
                <a className="btn btn-sm" href={item.sourceUrl} target="_blank" rel="noopener noreferrer">HLTV · {item.map}<ExternalLink size={14} /></a>
              </div>
              <div className={styles.mergedState}>
                <span className={item.reviewState === 'verified' ? styles.verifiedState : styles.pendingState}>
                  {item.reviewState === 'verified' ? '已复核' : item.sourceDataset === 'legacy_dataset' ? '旧库导入 · 未逐图复核' : 'HLTV 采集 · 未逐图复核'}
                </span>
              </div>
              <div className={styles.match}><strong>{item.sourceDataset === 'legacy_dataset' ? '同队五人' : `${item.team} 同队出场`}</strong><span>{item.sourceDataset === 'legacy_dataset' ? '比赛：' : ''}{item.opponents[0]} {item.score.join(' : ')} {item.opponents[1]} · {item.map}</span></div>
              <div className={styles.lineup} aria-label={`${item.map} 同队名单`}>
                {item.lineup.map(player => <span key={player.id} className={[result.playerA.id, result.playerB.id].includes(player.id) ? styles.highlighted : undefined} title={playerIdentityLabel(player)}>{player.nickname}</span>)}
              </div>
              <details className={styles.audit}>
                <summary>查看来源详情</summary>
                <dl>
                  {item.opponentLineup && <><dt>对手五人</dt><dd>{item.opponentLineup.map(player => `${player.nickname}（${playerIdentityLabel(player)}）`).join('、')}</dd></>}
                  {item.eventUrl && <><dt>赛事范围来源</dt><dd><a href={item.eventUrl} target="_blank" rel="noopener noreferrer">赛事页面<ExternalLink size={12} /></a></dd></>}
                  <dt>名单来源</dt><dd>{item.sourceDataset === 'legacy_dataset' ? '原始旧数据库导入，未逐图重新抓取' : item.reviewState === 'verified' ? `${item.review?.reviewedOn ?? '旧批次'} 已复核` : 'HLTV 页面采集，未逐图人工复核'}</dd>
                  <dt>原始显示时间</dt><dd>{item.dateRaw}（时区尚未统一）</dd>
                  <dt>来源指纹</dt><dd><code>{item.sourceFingerprint}</code></dd>
                  <dt>数据批次</dt><dd><code>{item.datasetVersion}</code></dd>
                  {item.corroboratingSources?.map(source => <Fragment key={`${source.sourceDataset}-${source.datasetVersion}`}>
                    <dt>重复来源</dt><dd><a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">同图页面<ExternalLink size={12} /></a>
                      {' · '}{source.sourceDataset} · <code>{source.datasetVersion}</code> · <code>{source.sourceFingerprint}</code></dd>
                  </Fragment>)}
                </dl>
              </details>
            </article>)}
            {result.hasMore && <button className="btn" disabled={busy} onClick={() => void lookup(result.playerA, result.playerB, result.evidence.length)}>加载更多地图</button>}
          </>}
        </section>}
        {!result && !busy && !error && <div className={styles.startHint}><GitBranch size={25} /><p>选择两名选手，查看各自来源的同队地图。</p></div>}
        <footer className={styles.footnote}>
          <p>旧库导入复用原有出场名单和 HLTV 链接；后续采集继续补充缺失记录。重复比赛可以作为同一段队友关系的多条证据，当前收录仍不代表完整历史。</p>
          <p>合并视图版本：<code>{meta.version}</code></p>
        </footer>
      </>}
    </div>
  </Page>;
}
