import styles from '../pages/Teammates.module.css';
import { Link } from 'react-router-dom';

export default function CsLinkPathRulesPreview() {
  return <aside className={styles.rulePreview} aria-label="多人对战规则">
    <div className={styles.ruleHeading}><div><span className={styles.serial}>PLAY / PATH DUEL</span><h2>限时连通，跳数优先</h2></div><Link to="/teammates/duel" className="btn btn-primary">进入连通对战</Link></div>
    <div className={styles.ruleGrid}>
      <div><h3>跳数少者胜；跳数相同，用时短者胜</h3><p>所有人连接同一对选手。限时内可以继续提交更短的路径，截止时取各自的最佳成绩；用时按这条最佳路径首次有效提交的时刻计算。</p></div>
    </div>
    <p className={styles.ruleFootnote}>未连通记为未完成；所有人都未完成，或最佳跳数和用时完全相同，则平局。每段队友关系算一跳，并附 HLTV 比赛链接。创建房间后，把邀请链接发给朋友即可加入。</p>
  </aside>;
}
