import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, GitBranch } from 'lucide-react';
import Page from '../components/Page';
import CsLinkPathRulesPreview from '../components/CsLinkPathRulesPreview';
import MergedPlayerPicker, { emptyMergedField, MergedField } from '../components/CsLinkMergedPlayerPicker';
import { api } from '../api/client';
import { PlayAnswer, PlayExplanation, PlayMeta, PlayPool, PlayQuestion, PlayReveal, playError } from '../api/cslinkPlay';
import { playerIdentityLabel } from '../api/cslinkMerged';
import styles from './Teammates.module.css';

function Proof({ answer, version }: { answer: PlayExplanation; version: string }) {
  return <article className={styles.evidence} aria-label={`${answer.player.nickname} 的两侧证据`}>
    <h3>{answer.player.nickname} <small>{playerIdentityLabel(answer.player)}</small></h3>
    <div className={styles.proofColumns}>
      {[answer.left, answer.right].map(side => <div key={side.endpoint.id} className={styles.proofSide}>
        <strong>{side.endpoint.nickname} ↔ {answer.player.nickname}</strong>
        <p>{side.proof.team} · {side.proof.event}</p>
        <p className={styles.hint}>{side.proof.dateRaw.slice(0, 10)} · {side.proof.map} · 比赛：{side.proof.opponents[0]} {side.proof.score.join(' : ')} {side.proof.opponents[1]}</p>
        <p className={styles.hint}>{side.proof.sourceDataset === 'legacy_dataset' ? '旧库导入 · 未逐图重新抓取' : side.proof.reviewState === 'verified' ? '已复核地图' : 'HLTV 采集地图'}</p>
        <div className={styles.lineup} aria-label={`${side.endpoint.nickname} 侧同队名单`}>
          {side.proof.lineup.map(player => <span key={player.id} title={playerIdentityLabel(player)} className={[side.endpoint.id, answer.player.id].includes(player.id) ? styles.highlighted : undefined}>{player.nickname}</span>)}
        </div>
        <a href={side.proof.sourceUrl} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>HLTV 地图 #{side.proof.mapId}<ExternalLink size={13} /></a>
        {side.proof.eventUrl && <a href={side.proof.eventUrl} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>赛事页面<ExternalLink size={13} /></a>}
        <details className={styles.audit}><summary>证据来源详情</summary>
          <dl><dt>地图状态</dt><dd>{side.proof.reviewState === 'verified' ? '已逐图复核' : side.proof.sourceDataset === 'legacy_dataset' ? '旧数据库导入，未逐图人工复核' : '已采集，未逐图人工复核'}</dd>
            <dt>同队地图</dt><dd>当前图共 {side.evidenceCount} 张，此处展示一张</dd>
            <dt>记录指纹</dt><dd><code>{side.proof.sourceFingerprint}</code></dd>
            <dt>数据版本</dt><dd><code>{version}</code></dd></dl>
        </details>
      </div>)}
    </div>
  </article>;
}

export default function TeammatePlay() {
  const location = useLocation();
  const navigate = useNavigate();
  const [pool, setPool] = useState<PlayPool>('bridge');
  const [meta, setMeta] = useState<PlayMeta | null>(null);
  const [question, setQuestion] = useState<PlayQuestion | null>(null);
  const [field, setField] = useState<MergedField>(emptyMergedField);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReturnType<typeof playError> | null>(null);
  const [feedback, setFeedback] = useState<PlayAnswer | null>(null);
  const [found, setFound] = useState<PlayExplanation[]>([]);
  const [revealed, setRevealed] = useState<PlayExplanation[] | null>(null);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const previousId = useRef<string | undefined>();

  const load = async (nextPool: PlayPool, pinned?: { id: string; version: string }) => {
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setQuestion(null); setField(emptyMergedField); setFeedback(null); setFound([]); setRevealed(null);
    setLoading(true); setSubmitting(false); setError(null);
    try {
      const [info, next] = await Promise.all([
        api.get<PlayMeta>('/cslink/play/meta', { signal: controller.signal }),
        pinned ? api.get<PlayQuestion>(`/cslink/play/question/${encodeURIComponent(pinned.id)}`, {
          params: { bankVersion: pinned.version }, signal: controller.signal,
        }) : api.get<PlayQuestion>('/cslink/play/question', {
          params: { pool: nextPool, previous: previousId.current }, signal: controller.signal,
        }),
      ]);
      if (current !== generation.current) return;
      if (info.data.dataVersion !== next.data.dataVersion || info.data.bankVersion !== next.data.bankVersion) {
        throw { response: { data: { code: 'CSLINK_PLAY_VERSION_CHANGED' } } };
      }
      setMeta(info.data); setQuestion(next.data); previousId.current = next.data.id;
      if (!pinned && location.search) navigate(location.pathname, { replace: true });
    } catch (err) { if (current === generation.current) setError(playError(err)); }
    finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('question'), version = params.get('version');
    void load('bridge', id && version ? { id, version } : undefined);
    return () => { generation.current++; pending.current?.abort(); };
  }, []);

  const submit = async (reveal: boolean) => {
    if (!question || submitting || (!reveal && !field.selected)) return;
    const current = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setSubmitting(true); setError(null);
    const body = { questionId: question.id, bankVersion: question.bankVersion };
    try {
      if (reveal) {
        const { data } = await api.post<PlayReveal>('/cslink/play/reveal', body, { signal: controller.signal });
        if (current !== generation.current) return;
        setRevealed(data.answers); setFeedback(null);
      } else {
        const { data } = await api.post<PlayAnswer>('/cslink/play/answer', { ...body, playerId: field.selected!.id }, { signal: controller.signal });
        if (current !== generation.current) return;
        setFeedback(data);
        if (data.explanation) setFound(items => items.some(item => item.player.id === data.player.id) ? items : [...items, data.explanation!]);
      }
    } catch (err) { if (current === generation.current) setError(playError(err)); }
    finally { if (current === generation.current) setSubmitting(false); }
  };
  const duplicate = !!field.selected && found.some(item => item.player.id === field.selected!.id);
  const endpoint = !!field.selected && [question?.playerA.id, question?.playerB.id].includes(field.selected.id);

  return <Page title="共同队友练习" className={styles.shell} icon={<GitBranch size={17} />}
    actions={<><Link to="/teammates" className="btn btn-sm">关系查询</Link><Link to="/teammates/practice/legacy" className="btn btn-sm">旧样本练习</Link></>}>
    <div className={styles.content}>
      <header className={styles.intro}><div className={styles.masthead}><span className={styles.eyebrow}>CS LINK / LOCAL PLAY</span><span className={styles.sectionIndex}>02 — 共同队友</span></div>
        <h1>谁连接了他们？</h1>
        <p>选一名同时与两位题面选手在同队地图中出场的人。每侧关系都能追溯到对应的 HLTV 地图。</p>
      </header>
      <div className={`${styles.coverage} ${styles.candidateCoverage}`}><span className={styles.coverageLabel}>DATA NOTE</span>
        <span>使用旧数据库与后续采集比赛中的同队名单，每个答案都附 HLTV 比赛链接。旧库名单直接导入，没有逐图重新抓取；目前尚未覆盖全部历史。</span>
      </div>
      <div className={styles.toolbar}>
        <label>练习模式 <select aria-label="练习模式" className={styles.poolSelect} value={pool} onChange={event => {
          const next = event.target.value as PlayPool; setPool(next); void load(next);
        }}><option value="bridge">跨阵容练习</option><option value="multiple">多答案检查</option><option value="all">全部候选</option></select></label>
        <button type="button" className="btn" disabled={loading} onClick={() => void load(pool)}>换一道题</button>
      </div>
      {loading && <p role="status">正在准备题目…</p>}
      {error && <div className={styles.notice} role="alert">{error.message}
        <button className="btn btn-sm" onClick={() => void load(pool)}>{error.code?.includes('VERSION_CHANGED') ? '更新题库并重新开始' : '重新加载题目'}</button>
      </div>}
      {question && <>
        <div className={styles.questionHeading}><span className={styles.serial}>01 / FIND THE LINK</span><p className={styles.questionLink}><a href={`/teammates/practice?question=${question.id}&version=${question.bankVersion}`}>固定这道题的链接</a><span>同一本地数据版本可复现</span></p></div>
        <div className={styles.questionChain} aria-label="题目端点">
          {[question.playerA, null, question.playerB].map((player, index) => player ? <div key={player.id} className={styles.endpoint}>
            <span className={styles.endpointNumber}>{index === 0 ? 'PLAYER / 01' : 'PLAYER / 02'}</span>
            <strong>{player.nickname}</strong>{player.hltvId && player.profileUrl ? <a href={player.profileUrl} target="_blank" rel="noopener noreferrer">{playerIdentityLabel(player)}<ExternalLink size={12} aria-hidden="true" /></a> : <span>{playerIdentityLabel(player)}</span>}
          </div> : <span key={index} className={styles.middle} aria-hidden="true"><b>?</b><small>共同队友</small></span>)}
        </div>
        <form className={styles.searchPanel} onSubmit={event => { event.preventDefault(); if (!duplicate && !endpoint && !revealed) void submit(false); }}>
          <div className={styles.panelHeading}><span className={styles.serial}>02 / YOUR ANSWER</span><span>同名时请留意选手编号或赛事</span></div>
          <fieldset className={styles.answerField} disabled={submitting || !!revealed}>
            <MergedPlayerPicker label="你的答案" field={field} version={question.dataVersion} searchPath="/cslink/play/players"
              onChange={value => { setField(value); setFeedback(null); }} />
          </fieldset>
          {endpoint && <p className={styles.hint}>中间人必须与两名题面选手不同。</p>}
          {duplicate && <p className={styles.hint}>这个答案已找到，可以尝试其他选手。</p>}
          <div className={styles.actions}>
            <button className="btn btn-primary" disabled={!field.selected || submitting || duplicate || endpoint || !!revealed}>{submitting ? '正在核对…' : '验证答案'}</button>
            <button type="button" className="btn btn-ghost" disabled={submitting || !!revealed} onClick={() => void submit(true)}>查看当前库全部答案</button>
          </div>
        </form>
        {feedback && <div className={styles.notice} role="status">{feedback.status === 'accepted' ?
          `${feedback.player.nickname}：在当前地图证据中成立。` : feedback.status === 'endpoint' ?
            '中间人必须与两名题面选手不同。' : `${feedback.player.nickname}：当前关系库尚未找到两侧证据，不能断言历史上不成立。`}</div>}
        {(revealed || found.length > 0) && <section aria-label="答案与证据">
          <h2>{revealed ? `当前库收录的 ${revealed.length} 个答案` : `已找到 ${found.length} 个答案`}</h2>
          {revealed && <p className={styles.hint}>这里只列出当前收录比赛中有证据的答案，并非完整历史答案。</p>}
          {(revealed ?? found).map(answer => <Proof key={answer.player.id} answer={answer} version={question.dataVersion} />)}
        </section>}
      </>}
      <CsLinkPathRulesPreview />
      {meta && <footer className={styles.footnote}>
        <p>{meta.sampledMaps - (meta.legacyImportedMaps ?? 0)} 张采集地图{meta.legacyImportedMaps ? ` · ${meta.legacyImportedMaps} 张旧库导入地图` : ''} · {meta.total} 道题，其中跨阵容 {meta.bridge} 道、多答案 {meta.multiple} 道。</p>
        <p>本地练习 · 题库版本：<code>{meta.bankVersion}</code> · 数据版本：<code>{meta.dataVersion}</code></p>
      </footer>}
    </div>
  </Page>;
}
