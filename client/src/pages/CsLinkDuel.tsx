import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, Copy, ExternalLink, GitBranch } from 'lucide-react';
import Page from '../components/Page';
import MergedPlayerPicker, { emptyMergedField, type MergedField } from '../components/CsLinkMergedPlayerPicker';
import { getSocket } from '../api/socket';
import { playerIdentityLabel } from '../api/cslinkMerged';
import type { PlayPlayer } from '../api/cslinkPlay';
import { type DuelFinish, type DuelResponse, type DuelRoom, duelError, formatDuelTime, parseDuelRoomInput } from '../api/cslinkDuel';
import shared from './Teammates.module.css';
import styles from './CsLinkDuel.module.css';

const REQUEST_TIMEOUT_MS = 10_000;

function PathEvidence({ finish }: { finish: DuelFinish }) {
  const names = new Map(finish.route.map(player => [player.id, player.nickname]));
  return <ol className={styles.proofs} aria-label="每跳比赛证据">
    {finish.hops.map((hop, index) => <li key={`${hop.fromId}-${hop.toId}`}>
      <span>{names.get(hop.fromId)} → {names.get(hop.toId)}</span>
      <a href={hop.evidence.sourceUrl} target="_blank" rel="noopener noreferrer"
        aria-label={`第 ${index + 1} 跳 HLTV 地图 #${hop.evidence.mapId}`}>
        HLTV #{hop.evidence.mapId}<ExternalLink size={12} />
      </a>
    </li>)}
  </ol>;
}

function Rules() {
  return <p className={styles.rules}>所有人连接同一对选手，在限时内取各自的最佳路径。先比跳数，跳数相同再比这条路径的首次有效提交时间；连通后仍可继续优化。未连通记为未完成，都未完成或成绩完全相同则平局。每段队友关系算一跳，并有 HLTV 比赛链接。</p>;
}

export default function CsLinkDuel() {
  const { roomId: routeRoomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const [room, setRoom] = useState<DuelRoom | null>(null);
  const [meKey, setMeKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(20);
  const [maxPlayers, setMaxPlayers] = useState(2);
  const [joinInput, setJoinInput] = useState('');
  const [field, setField] = useState<MergedField>(emptyMergedField);
  const [middle, setMiddle] = useState<PlayPlayer[]>([]);
  const [now, setNow] = useState(Date.now());
  const [clockOffset, setClockOffset] = useState(0);
  const [copied, setCopied] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const roomRef = useRef<DuelRoom | null>(null);
  const alive = useRef(false), generation = useRef(0), operation = useRef(0);
  const latestServerTime = useRef(0);
  const ignoredRooms = useRef(new Set<string>());

  const accept = (response: DuelResponse): boolean => {
    if (!alive.current) return false;
    const next = response.room;
    if (next && ignoredRooms.current.has(next.id)) return false;
    if (next && roomRef.current?.id === next.id && next.revision < roomRef.current.revision) return false;
    if (response.serverNowMs !== undefined && response.serverNowMs < latestServerTime.current) return false;
    if (response.serverNowMs !== undefined) {
      latestServerTime.current = response.serverNowMs;
      setClockOffset(response.serverNowMs - Date.now());
    }
    if (response.meKey) setMeKey(response.meKey);
    if (next !== undefined) { roomRef.current = next; setRoom(next); }
    return true;
  };

  const rpc = (event: string, payload: Record<string, unknown>): Promise<DuelResponse> => {
    const socket = getSocket();
    if (!socket.connected) return Promise.resolve({ code: 'NETWORK_ERROR' });
    return new Promise(resolve => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (!settled) { settled = true; resolve({ code: 'REQUEST_TIMEOUT' }); }
      }, REQUEST_TIMEOUT_MS);
      socket.emit(`cslink:${event}`, payload, (response: DuelResponse) => {
        if (settled) return;
        settled = true; window.clearTimeout(timeout);
        resolve(response ?? { code: 'REQUEST_TIMEOUT' });
      });
    });
  };

  const restore = async () => {
    const current = ++generation.current;
    setRestoring(true);
    let response = await rpc('sync', {});
    if (!alive.current || current !== generation.current) return;
    if (!response.code && routeRoomId && response.room?.id !== routeRoomId) {
      ignoredRooms.current.delete(routeRoomId);
      response = await rpc('join', { roomId: routeRoomId });
    }
    if (!alive.current || current !== generation.current) return;
    accept(response);
    setRestoring(false);
    setError(response.code ? duelError(response.code, response.reason) : '');
    if (!response.code && response.room && response.room.id !== routeRoomId) {
      navigate(`/teammates/duel/${encodeURIComponent(response.room.id)}`, { replace: true });
    }
  };

  useEffect(() => {
    alive.current = true;
    setRestoring(true);
    const socket = getSocket();
    const onConnect = () => { setConnected(true); setError(''); void restore(); };
    const onDisconnect = () => {
      generation.current++; operation.current++;
      setConnected(false); setBusy(''); setRestoring(false);
      setError(duelError('NETWORK_ERROR'));
    };
    const onError = (failure: { message?: string }) => {
      const code = /^[A-Z_]+$/.test(failure.message ?? '') ? failure.message! : 'NETWORK_ERROR';
      setConnected(false); setRestoring(false); setError(`${duelError(code)}（${code}）`);
    };
    const onState = (response: DuelResponse) => {
      if (response.room && routeRoomId && response.room.id !== routeRoomId) return;
      accept(response);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    socket.on('cslink:state', onState);
    setConnected(socket.connected);
    if (socket.connected) void restore();
    const connectTimeout = window.setTimeout(() => {
      if (!socket.connected && alive.current) {
        setRestoring(false); setError(previous => previous || '连接尚未建立，请重新连接。');
      }
    }, REQUEST_TIMEOUT_MS);
    return () => {
      alive.current = false; generation.current++; operation.current++;
      window.clearTimeout(connectTimeout);
      socket.off('connect', onConnect); socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError); socket.off('cslink:state', onState);
    };
  }, [routeRoomId, connectionAttempt]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    setMiddle(room?.myBest?.route.slice(1, -1) ?? []);
    setField(emptyMergedField); setFeedback('');
  }, [room?.round?.roundId]);

  // Report arrival once per round so the server can start the clock as soon as everyone is in.
  useEffect(() => {
    const current = roomRef.current;
    if (current?.status !== 'playing' || !current.round) return;
    void rpc('arrive', { roomId: current.id, roundId: current.round.roundId }).then(response => {
      if (alive.current) accept(response);
    });
  }, [room?.round?.roundId]);

  const act = async (event: string, payload: Record<string, unknown>) => {
    if (busy) return;
    const current = ++operation.current;
    const requestRound = roomRef.current?.round?.roundId;
    setBusy(event); setError(''); setFeedback('');
    const response = await rpc(event, payload);
    if (!alive.current || current !== operation.current) return;
    setBusy('');
    const applied = accept(response);
    if (!applied) return;
    if (response.code) { setError(duelError(response.code, response.reason)); return; }
    if (event === 'leave') {
      if (typeof payload.roomId === 'string') ignoredRooms.current.add(payload.roomId);
      roomRef.current = null; setRoom(null);
      navigate('/teammates/duel', { replace: true });
    } else if ((event === 'create' || event === 'join') && response.room) {
      navigate(`/teammates/duel/${encodeURIComponent(response.room.id)}`);
    } else if (event === 'submit' && requestRound === roomRef.current?.round?.roundId) {
      setFeedback(response.improved ? '连通成功，最佳成绩已更新。还能继续寻找更短的路径。' : '路径连通。之前的成绩更优，已为你保留。');
    }
  };

  const round = room?.round;
  const remainingMs = round ? Math.max(0, round.serverDeadlineAtMs - now - clockOffset) : 0;
  const seconds = Math.ceil(remainingMs / 1000);
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const me = room?.players.find(player => player.key === meKey);
  const isHost = room?.hostKey === meKey;
  const activePlayers = room?.players.filter(player => !player.left) ?? [];
  const canStart = activePlayers.length >= 2 && activePlayers.every(player => player.ready && player.connected);
  const unavailable = !connected || Boolean(busy) || restoring;
  const canEdit = room?.status === 'playing' && remainingMs > 0 && !me?.left && !unavailable;
  const pathPlayers = round ? [round.start, ...middle, round.end] : [];
  const duplicate = Boolean(field.selected && pathPlayers.some(player => player.id === field.selected!.id));
  const roomUrl = room ? `${window.location.origin}/teammates/duel/${encodeURIComponent(room.id)}` : '';
  const copyRoom = async () => {
    try { await navigator.clipboard.writeText(roomUrl); setCopied(true); }
    catch { setError('复制未成功，可以直接复制下方的房间链接。'); }
  };

  return <Page title="连通对战" className={shared.shell} icon={<GitBranch size={17} />}
    actions={<><Link to="/teammates/practice" className="btn btn-sm btn-ghost">单人练习</Link><Link to="/teammates" className="btn btn-sm btn-ghost">关系查询</Link></>}>
    <div className={styles.content}>
      <div className={styles.masthead}><span>CS LINK / PATH DUEL</span><span role="status" className={connected ? styles.online : styles.offline}>{connected ? '已连接' : '连接中'}</span></div>
      {error && <div role="alert" className={styles.notice}>{error} {connected
        ? <button className="btn btn-sm btn-ghost" disabled={restoring} onClick={() => void restore()}>同步房间</button>
        : <button className="btn btn-sm btn-ghost" onClick={() => { setError(''); setConnectionAttempt(value => value + 1); }}>重新连接</button>}</div>}
      {restoring && <p role="status" className={styles.muted}>正在恢复房间…</p>}
      {!room && <>
        <header className={styles.intro}><h1>更少的跳数，更快的连接。</h1><p>和朋友连接同一对选手。限时内找到自己的最佳路径，截止后一起看每一跳的比赛证据。</p></header>
        <div className={styles.lobbyGrid}>
          <section className={styles.panel} aria-label="创建连通房间"><h2>创建房间</h2>
            <div className={styles.settings}><div><label htmlFor="duel-duration">每局时长</label><select id="duel-duration" value={durationSeconds} onChange={event => setDurationSeconds(Number(event.target.value))}>
              <option value={20}>20 秒</option><option value={60}>1 分钟</option><option value={180}>3 分钟</option>
            </select></div><div><label htmlFor="duel-capacity">人数上限</label><select id="duel-capacity" value={maxPlayers} onChange={event => setMaxPlayers(Number(event.target.value))}>
              <option value={2}>2 人</option><option value={4}>4 人</option><option value={8}>8 人</option>
            </select></div></div>
            <button className="btn btn-primary" disabled={unavailable} onClick={() => void act('create', { durationSeconds, maxPlayers })}>{busy === 'create' ? '创建中…' : '创建连通房间'}</button>
          </section>
          <section className={styles.panel} aria-label="加入连通房间"><h2>加入朋友</h2><form onSubmit={event => {
            event.preventDefault(); const id = parseDuelRoomInput(joinInput);
            if (!id) { setError('请输入有效的房间号或分享链接。'); return; }
            ignoredRooms.current.delete(id); void act('join', { roomId: id });
          }}><label htmlFor="duel-room-code">房间号或分享链接</label><input id="duel-room-code" value={joinInput} onChange={event => setJoinInput(event.target.value)} placeholder="粘贴朋友发来的链接" autoComplete="off" maxLength={500} />
            <button className="btn btn-ghost" disabled={unavailable || !joinInput.trim()}>{busy === 'join' ? '加入中…' : '加入房间'}</button>
          </form></section>
        </div>
        {routeRoomId && <Link to="/teammates/duel" className="btn btn-ghost">返回对战大厅</Link>}
        <Rules />
      </>}
      {room && <>
        <header className={styles.roomHeading}><div><small>{room.status === 'lobby' ? '等待准备' : room.status === 'playing' ? '比赛进行中' : '本局结束'} · {room.durationSeconds < 60 ? `${room.durationSeconds} 秒` : `${room.durationSeconds / 60} 分钟`}</small>
          <h1>房间 <span className={styles.roomCode}>{room.id}</span></h1>
          <p className={styles.share}>{roomUrl}</p>
        </div><div className={styles.controls}>
          <button className="btn btn-sm btn-ghost" onClick={() => void copyRoom()}><Copy size={14} />{copied ? '链接已复制' : '复制邀请链接'}</button>
          <button className="btn btn-sm btn-ghost" disabled={unavailable} onClick={() => void act('leave', { roomId: room.id })}>退出房间</button>
        </div></header>

        {room.status === 'lobby' && <section className={styles.panel} aria-label="房间准备">
          <div className={styles.sectionHeading}><h2>等待朋友加入</h2><span className={styles.muted}>{activePlayers.length} / {room.maxPlayers} 人</span></div>
          <ul className={styles.players}>{room.players.filter(player => !player.left).map(player => <li className={styles.playerLine} key={player.key}>
            <span className={styles.playerName}><strong>{player.name}</strong><small>{player.key === meKey ? '你' : ''}{player.key === room.hostKey ? ' · 房主' : ''}</small></span>
            <span className={player.ready && player.connected ? styles.online : styles.muted}>{!player.connected ? '已断线' : player.ready ? '已准备' : '未准备'}</span>
          </li>)}</ul>
          <div className={styles.controls}>
            <button className={`btn ${me?.ready ? 'btn-ghost' : 'btn-primary'}`} disabled={unavailable || !me || me.left} onClick={() => void act('ready', { roomId: room.id, ready: !me?.ready })}>{me?.ready ? '取消准备' : '准备'}</button>
            {isHost ? <button className="btn btn-primary" disabled={unavailable || !canStart} onClick={() => void act('start', { roomId: room.id })}>{busy === 'start' ? '出题中…' : '开始对战'}</button> : <p className={styles.muted}>所有人准备后，由房主开始。</p>}
          </div><Rules />
        </section>}

        {round && <>
          <section className={styles.panel} aria-label="本局题目">
            <div className={styles.sectionHeading}><h2>连接这两名选手</h2><div className={styles.timer}>
              <span className={styles.clockLabel}>{room.status === 'finished' ? '已结束' : remainingMs > 0 ? '剩余时间' : '等待服务器结算'}</span>
              <span className={styles.clock} aria-label={`剩余时间 ${remaining}`}>{room.status === 'finished' ? '0:00' : remaining}</span>
            </div></div>
            <div className={styles.endpoints}>{[round.start, round.end].map((player, index) => <div key={player.id} className={styles.endpoint} style={index ? { gridColumn: 3 } : undefined}>
              <small>{index ? '终点' : '起点'}</small><strong>{player.nickname}</strong><span>{playerIdentityLabel(player)}</span>
            </div>)}<ArrowRight className={styles.arrow} style={{ gridRow: 1, gridColumn: 2 }} /></div>
            <ul className={styles.players} aria-label="对战进度">{room.players.map(player => <li className={styles.playerLine} key={player.key}>
              <span className={styles.playerName}><strong>{player.name}</strong><small>{player.key === meKey ? '你' : ''}{player.left ? ' · 已退出' : !player.connected ? ' · 已断线' : ''}</small></span>
              <span className={styles.score}>{!player.best ? '未连通' : player.best.elapsedMs === null
                ? `已连通 · ${player.best.jumps} 跳` : `${player.best.jumps} 跳 · ${formatDuelTime(player.best.elapsedMs)}`}</span>
            </li>)}</ul>
          </section>

          {room.status === 'playing' && <section className={styles.panel} aria-label="编辑你的路径">
            <div className={styles.sectionHeading}><h2>你的路径</h2><span className={styles.muted}>{middle.length + 1} 跳 · 最多 {round.maxJumps} 跳</span></div>
            <fieldset disabled={!canEdit} className={styles.editor}>
              <ol className={styles.route} aria-label="当前路径">{pathPlayers.map((player, index) => <li key={player.id}>
                <div className={styles.routeNode}><strong>{player.nickname}</strong><small>{index === 0 ? '起点' : index === pathPlayers.length - 1 ? '终点' : playerIdentityLabel(player)}</small>
                  {index > 0 && index < pathPlayers.length - 1 && <div className={styles.routeActions}>
                    <button type="button" aria-label={`前移 ${player.nickname}`} disabled={index === 1} onClick={() => setMiddle(items => { const next = [...items]; [next[index - 2], next[index - 1]] = [next[index - 1], next[index - 2]]; return next; })}>←</button>
                    <button type="button" aria-label={`后移 ${player.nickname}`} disabled={index === middle.length} onClick={() => setMiddle(items => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>→</button>
                    <button type="button" aria-label={`移除 ${player.nickname}`} onClick={() => setMiddle(items => items.filter(item => item.id !== player.id))}>移除</button>
                  </div>}
                </div>
              </li>)}</ol>
              <div className={styles.pickerRow}><MergedPlayerPicker label="添加中间选手" version={round.dataVersion} searchPath="/cslink/play/players" field={field} onChange={setField} />
                <button type="button" className="btn btn-ghost" disabled={!field.selected || duplicate || middle.length >= round.maxJumps - 1} onClick={() => {
                  if (field.selected && !duplicate) { setMiddle(items => [...items, field.selected!]); setField(emptyMergedField); }
                }}>加入路径</button>
              </div>
              {duplicate && <p className={styles.muted}>路径里已经有这名选手，请选择其他人。</p>}
              <div className={styles.controls}>
                <button className="btn btn-primary" onClick={() => void act('submit', { roomId: room.id, roundId: round.roundId, dataVersion: round.dataVersion, routeIds: pathPlayers.map(player => player.id), eventId: crypto.randomUUID() })}>{busy === 'submit' ? '核对中…' : '提交路径'}</button>
                <button className="btn btn-ghost" disabled={!middle.length} onClick={() => { setMiddle([]); setField(emptyMergedField); }}>清空中间选手</button>
              </div>
            </fieldset>
            {feedback && <p role="status" className={styles.notice}>{feedback}</p>}
            {room.myBest && <div className={styles.best}><span>已保存最佳成绩<strong>{room.myBest.jumps} 跳 · {formatDuelTime(room.myBest.elapsedMs)}</strong></span>
              <button className="btn btn-sm btn-ghost" disabled={!canEdit} onClick={() => { setMiddle(room.myBest!.route.slice(1, -1)); setField(emptyMergedField); }}>恢复最佳路径</button>
            </div>}
            <Rules />
          </section>}

          {room.status === 'finished' && room.result && <section className={styles.panel} aria-label="本局结果">
            <div className={styles.sectionHeading}><h2>{room.result.reason === 'all_incomplete' ? '本局平局 · 所有人未完成' : room.result.reason === 'exact_tie' ? '本局平局 · 最佳成绩相同' : `${room.result.rankings.filter(player => room.result!.winnerKeys.includes(player.key)).map(player => player.name).join('、')} 获胜`}</h2>
              {isHost && <button className="btn btn-primary" disabled={unavailable} onClick={() => void act('rematch', { roomId: room.id })}>再来一局</button>}
            </div>
            {!isHost && <p className={styles.muted}>等待房主开启下一局。</p>}
            {room.result.rankings.map(player => <article key={player.key} className={styles.result}>
              <div className={styles.resultTitle}><h3>{player.rank !== null ? `${player.rank}. ` : ''}{player.name}{player.key === meKey ? '（你）' : ''}</h3><span className={styles.score}>{player.best ? `${player.best.jumps} 跳 · ${formatDuelTime(player.best.elapsedMs)}` : '未完成'}</span></div>
              {player.best && <><p className={styles.muted}>{player.best.route.map(item => item.nickname).join(' → ')}</p><PathEvidence finish={player.best} /></>}
            </article>)}
            <Rules />
          </section>}
        </>}
      </>}
    </div>
  </Page>;
}
