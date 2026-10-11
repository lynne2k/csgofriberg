import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, GitBranch } from 'lucide-react';
import Page from '../components/Page';
import CsLinkPathRulesPreview from '../components/CsLinkPathRulesPreview';
import PlayerPicker, { emptyField, Field } from '../components/CsLinkPlayerPicker';
import { api } from '../api/client';
import { AnswerExplanation, evidenceError, PracticeAnswer, PracticeMeta, PracticeQuestion, PracticeReveal, QuestionPool } from '../api/cslink';
import styles from './Teammates.module.css';

function Explanation({ answer, dataVersion }: { answer: AnswerExplanation; dataVersion: string }) {
  return <article className={styles.evidence} aria-label={`${answer.player.nickname} 的两侧证据`}>
    <h3>{answer.player.nickname} <small>HLTV #{answer.player.hltvId}</small></h3>
    <div className={styles.proofColumns}>
      {[answer.left, answer.right].map(side => <div key={side.endpoint.id} className={styles.proofSide}>
        <strong>{side.endpoint.nickname} ↔ {answer.player.nickname}</strong>
        <p>{side.proof.team} · {side.proof.event}</p>
        <p className={styles.hint}>{side.proof.dateRaw.slice(0, 10)} · {side.proof.map} · {side.proof.opponents[0]} {side.proof.score.join(' : ')} {side.proof.opponents[1]}</p>
        <div className={styles.lineup} aria-label={`${side.endpoint.nickname} 侧同队名单`}>
          {side.proof.lineup.map(p => <span key={p.id} className={[side.endpoint.id, answer.player.id].includes(p.id) ? styles.highlighted : undefined}>{p.nickname}</span>)}
        </div>
        <a href={side.proof.sourceUrl} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>查看 HLTV 地图 #{side.proof.mapId}<ExternalLink size={13} /></a>
        <details className={styles.audit}><summary>证据与复核详情</summary>
          <dl><dt>此侧已核实证据</dt><dd>{side.evidenceCount} 张地图，此处展示一张</dd>
            <dt>复核日期</dt><dd>{side.proof.review.reviewedOn}</dd>
            <dt>记录指纹</dt><dd><code>{side.proof.recordSha256}</code></dd>
            <dt>原始记录位置</dt><dd>{Object.values(side.proof.sourceRefs).flat().map((ref, i) => <div key={i}>{ref.file} · CSV 记录 {ref.csv_record}</div>)}</dd>
            <dt>数据版本</dt><dd><code>{dataVersion}</code></dd></dl>
        </details>
      </div>)}
    </div>
  </article>;
}

export default function TeammatePractice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [pool, setPool] = useState<QuestionPool>('bridge');
  const [meta, setMeta] = useState<PracticeMeta | null>(null);
  const [question, setQuestion] = useState<PracticeQuestion | null>(null);
  const [field, setField] = useState<Field>(emptyField);
  const [loading, setLoading] = useState(true), [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ReturnType<typeof evidenceError> | null>(null);
  const [feedback, setFeedback] = useState<PracticeAnswer | null>(null);
  const [found, setFound] = useState<AnswerExplanation[]>([]);
  const [revealed, setRevealed] = useState<AnswerExplanation[] | null>(null);
  const generation = useRef(0), pending = useRef<AbortController | null>(null);
  const previousId = useRef<string | undefined>();

  const load = async (nextPool: QuestionPool, pinned?: { id: string; version: string }) => {
    const current = ++generation.current;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setQuestion(null); setField(emptyField); setFeedback(null); setFound([]); setRevealed(null);
    setLoading(true); setSubmitting(false); setError(null);
    try {
      const [info, next] = await Promise.all([
        api.get<PracticeMeta>('/cslink/practice/meta', { signal: controller.signal }),
        pinned ? api.get<PracticeQuestion>(`/cslink/practice/question/${encodeURIComponent(pinned.id)}`, {
          params: { bankVersion: pinned.version }, signal: controller.signal,
        }) : api.get<PracticeQuestion>('/cslink/practice/question', {
          params: { pool: nextPool, previous: previousId.current }, signal: controller.signal,
        }),
      ]);
      if (current !== generation.current) return;
      if (info.data.bankVersion !== next.data.bankVersion) throw { response: { data: { code: 'CSLINK_VERSION_CHANGED' } } };
      setMeta(info.data); setQuestion(next.data); previousId.current = next.data.id;
      if (!pinned && location.search) navigate(location.pathname, { replace: true });
    } catch (err) { if (current === generation.current) setError(evidenceError(err)); }
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
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller;
    setSubmitting(true); setError(null);
    const body = { questionId: question.id, bankVersion: question.bankVersion };
    try {
      if (reveal) {
        const { data } = await api.post<PracticeReveal>('/cslink/practice/reveal', body, { signal: controller.signal });
        if (current !== generation.current) return;
        setRevealed(data.answers); setFeedback(null);
      } else {
        const { data } = await api.post<PracticeAnswer>('/cslink/practice/answer', { ...body, playerId: field.selected!.id }, { signal: controller.signal });
        if (current !== generation.current) return;
        setFeedback(data);
        if (data.explanation) setFound(items => items.some(x => x.player.id === data.player.id) ? items : [...items, data.explanation!]);
      }
    } catch (err) { if (current === generation.current) setError(evidenceError(err)); }
    finally { if (current === generation.current) setSubmitting(false); }
  };
  const duplicate = !!field.selected && found.some(x => x.player.id === field.selected!.id);
  const endpoint = !!field.selected && [question?.playerA.id, question?.playerB.id].includes(field.selected.id);

  return <Page title="共同队友练习" className={styles.shell} icon={<GitBranch size={17} />} actions={<Link to="/teammates" className="btn btn-sm">关系查询</Link>}>
    <div className={styles.content}>
      <header className={styles.intro}><div className={styles.masthead}><span className={styles.eyebrow}>CS LINK / PATH STUDY</span><span className={styles.sectionIndex}>02 — 单人练习</span></div>
        <h1>谁分别和他们做过队友？</h1>
        <p>填入一名中间人，只要两侧都有已核实的同队出场证据就接受。不限于预先挑选的一个答案。</p>
      </header>
      <div className={styles.coverage}><span className={styles.coverageLabel}>DATA NOTE</span><span>当前仅为开发样本，尚未按 A/S 赛事范围验收；未收录的答案只提示“尚未证实”。本地练习不计排名。</span></div>
      <div className={styles.toolbar}>
        <label>练习模式 <select aria-label="练习模式" className={styles.poolSelect} value={pool} onChange={event => {
          const next = event.target.value as QuestionPool; setPool(next); void load(next);
        }}><option value="bridge">跨阵容练习</option><option value="multiple">多答案检查</option><option value="all">全部候选</option></select></label>
        <button type="button" className="btn" disabled={loading} onClick={() => void load(pool)}>换一道题</button>
      </div>
      {loading && <p role="status">正在准备题目…</p>}
      {error && <div className={styles.notice} role="alert">{error.message}
        <button className="btn btn-sm" onClick={() => void load(pool)}>{error.code === 'CSLINK_VERSION_CHANGED' ? '更新题库并重新开始' : '重新加载题目'}</button>
      </div>}
      {question && <>
        <div className={styles.questionHeading}><span className={styles.serial}>01 / FIND THE LINK</span><p className={styles.questionLink}><a href={`/teammates/practice/legacy?question=${question.id}&version=${question.bankVersion}`}>固定这道题的链接</a><span>同一站点打开可复现；仅限本地开发环境。</span></p></div>
        <div className={styles.questionChain} aria-label="题目端点">
          {[question.playerA, null, question.playerB].map((p, index) => p ? <div key={p.id} className={styles.endpoint}>
            <span className={styles.endpointNumber}>{index === 0 ? 'PLAYER / 01' : 'PLAYER / 02'}</span>
            <strong>{p.nickname}</strong><span>{p.name ?? '姓名未补充'}</span><a href={p.profileUrl} target="_blank" rel="noopener noreferrer">HLTV #{p.hltvId}<ExternalLink size={12} aria-hidden="true" /></a>
          </div> : <span key={index} className={styles.middle} aria-hidden="true"><b>?</b><small>共同队友</small></span>)}
        </div>
        <form className={styles.searchPanel} onSubmit={event => { event.preventDefault(); if (!duplicate && !endpoint && !revealed) void submit(false); }}>
          <div className={styles.panelHeading}><span className={styles.serial}>02 / YOUR ANSWER</span><span>请选择确切的选手身份</span></div>
          <fieldset className={styles.answerField} disabled={submitting || !!revealed}>
            <PlayerPicker label="你的答案" field={field} version={question.dataVersion} onChange={value => { setField(value); setFeedback(null); }} />
          </fieldset>
          {endpoint && <p className={styles.hint}>中间人必须与两名题面选手不同。</p>}
          {duplicate && <p className={styles.hint}>这个答案已找到，可以尝试其他选手。</p>}
          <div className={styles.actions}>
            <button className="btn btn-primary" disabled={!field.selected || submitting || duplicate || endpoint || !!revealed}>{submitting ? '正在核对…' : '验证答案'}</button>
            <button type="button" className="btn btn-ghost" disabled={submitting || !!revealed} onClick={() => void submit(true)}>查看当前库全部答案</button>
          </div>
        </form>
        {feedback && <div className={styles.notice} role="status">
          {feedback.status === 'accepted' ? `${feedback.player.nickname}：答案成立，两侧证据如下。` :
            feedback.status === 'endpoint' ? '中间人必须与两名题面选手不同。' : `${feedback.player.nickname}：当前库尚未证实两侧关系，不能据此断言历史上不成立。`}
        </div>}
        {(revealed || found.length > 0) && <section aria-label="答案与证据">
          <h2>{revealed ? `当前库已证实的 ${revealed.length} 个答案` : `已找到 ${found.length} 个答案`}</h2>
          {revealed && <p className={styles.hint}>这里列出本版本的完整交集；不代表全部历史答案已收录。</p>}
          {(revealed ?? found).map(answer => <Explanation key={answer.player.id} answer={answer} dataVersion={question.dataVersion} />)}
        </section>}
      </>}
      <CsLinkPathRulesPreview />
      {meta && <footer className={styles.footnote}>
        <p>{meta.total} 道候选 · {meta.bridge} 道跨阵容 · {meta.multiple} 道多答案。候选题仍待覆盖与人工验收。</p>
        <p>当前样本来自已核实的正式比赛实际出场，但含 A/S 范围外赛事；地图日期 {meta.verifiedDateRangeRaw.first?.slice(0, 10)} 至 {meta.verifiedDateRangeRaw.last?.slice(0, 10)}。原始时区未知，不代表期间全量比赛。</p>
        <p>题库版本：<code>{meta.bankVersion}</code> · 数据版本：<code>{meta.dataVersion}</code></p>
      </footer>}
    </div>
  </Page>;
}
