import type { PlayPlayer } from './cslinkPlay';

export interface DuelFinish {
  roundId: string;
  dataVersion: string;
  startId: string;
  endId: string;
  routeIds: string[];
  route: PlayPlayer[];
  jumps: number;
  serverCompletedAtMs: number;
  elapsedMs: number;
  hops: { fromId: string; toId: string; evidence: {
    mapId: number; sourceUrl: string; recordSha256: string; evidenceCount: number;
  } }[];
}

export interface DuelRoom {
  id: string;
  revision: number;
  status: 'lobby' | 'playing' | 'finished';
  hostKey: string;
  maxPlayers: number;
  durationSeconds: number;
  /** First player to this many round wins takes the match. */
  targetScore: number;
  matchOver: boolean;
  roundNo: number;
  nextRoundAtMs: number | null;
  /** Players who have not opened the duel page for the current round yet. */
  waitingKeys: string[];
  ranked?: boolean;
  ladderDelta?: Record<string, number> | null;
  players: { key: string; name: string; connected: boolean; ready: boolean; left: boolean;
    score: number; gaveUp: boolean; rating?: number | null; best: { jumps: number; elapsedMs: number | null } | null }[];
  round: { roundId: string; dataVersion: string; start: PlayPlayer; end: PlayPlayer;
    serverStartedAtMs: number; serverDeadlineAtMs: number; maxJumps: number } | null;
  myBest: DuelFinish | null;
  result: { winnerKeys: string[];
    reason: 'all_incomplete' | 'one_completed' | 'fewer_jumps' | 'faster_time' | 'exact_tie';
    rankings: { key: string; name: string; rank: number | null; best: DuelFinish | null; left: boolean; gaveUp: boolean }[];
  } | null;
}

export interface DuelResponse {
  code?: string;
  reason?: string;
  room?: DuelRoom | null;
  meKey?: string;
  serverNowMs?: number;
  improved?: boolean;
  queue?: { sinceMs: number; waiting: number };
}

export function duelError(code?: string, reason?: string): string {
  if (code === 'INVALID_PATH') return ({
    wrong_endpoints: '路径必须从题目起点出发，到终点结束。',
    too_many_jumps: '路径过长，请减少中间选手。',
    repeated_player: '同一路径不能重复经过一名选手。',
    unknown_player: '路径中有选手不在本局关系库中，请重新选择。',
    unverified_jump: '路径尚未连通：至少一段在当前关系库中没有同队比赛记录。',
  } as Record<string, string>)[reason ?? ''] ?? '路径尚未连通，请检查相邻选手的队友关系。';
  return ({
    VALIDATION_FAILED: '房间参数不正确，请检查后重试。',
    IDENTITY_REQUIRED: '访客身份尚未就绪，请刷新页面重连。',
    AUTH_EXPIRED: '登录状态已过期，正在恢复身份。',
    TOO_MANY_CONNECTIONS: '当前身份或网络连接数过多，请关闭多余的游戏页面，稍后重新连接。',
    RATE_LIMITED: '操作太快，请稍后再试。',
    ALREADY_IN_ROOM: '你已在另一个房间中，请先返回并退出那个房间。',
    ROOM_NOT_FOUND: '没有找到这个房间，可能已经关闭。',
    ROOM_FULL: '房间已满。',
    ROOM_LIMIT: '目前房间数量已达上限，请稍后再试。',
    ROOM_NOT_JOINABLE: '比赛已经开始，请等下一局。',
    NOT_IN_ROOM: '你已不在这个房间中，请重新加入。',
    HOST_ONLY: '只有房主可以进行这项操作。',
    NOT_READY: '请等所有玩家准备后再开始。',
    NOT_ENOUGH_PLAYERS: '至少需要两名玩家。',
    NOT_LOBBY: '本局已开始，不能修改准备状态。',
    NOT_PLAYING: '目前不在比赛中。',
    NOT_FINISHED: '请等本局结束后再开下一局。',
    ROUND_EXPIRED: '本局时间已到，等待结算。',
    ROUND_MISMATCH: '房间已经进入新的一局，旧提交未计入。',
    VERSION_MISMATCH: '本局数据版本与提交不一致，请重新同步房间。',
    LEFT_ROUND: '你已退出本局，可以等房主开启下一局。',
    NO_QUESTION: '当前关系库暂时无法生成对战题目。',
    NO_ACTIVE_PLAYERS: '房间里没有可参加下一局的玩家。',
    EVENT_ID_CONFLICT: '这次提交已处理，请同步房间后重试。',
    TOO_MANY_SUBMISSIONS: '本局提交次数已达上限。',
    GAVE_UP: '你已放弃本局，等下一局吧。',
    ALREADY_CONNECTED: '你已经连通了，不用放弃。',
    RANKED_FIXED: '天梯局规则固定，不能修改。',
    CSLINK_DUEL_UNAVAILABLE: '多人路径房间尚未加载，请稍后重试。',
    NETWORK_ERROR: '连接已断开，重连后会恢复房间和已提交成绩。',
    REQUEST_TIMEOUT: '服务器暂未回复。可以同步房间，确认刚才的操作是否已成功。',
  } as Record<string, string>)[code ?? ''] ?? '操作未完成，请同步房间后重试。';
}

export function formatDuelTime(ms: number): string {
  return `${(ms / 1000).toFixed(2)} 秒`;
}

export function parseDuelRoomInput(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return decodeURIComponent(url.pathname.match(/\/teammates\/duel\/([^/]+)\/?$/)?.[1] ?? '').trim();
  } catch {
    return trimmed.replace(/^\/teammates\/duel\//, '').replace(/\/$/, '');
  }
}
