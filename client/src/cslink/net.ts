/* 牌桌页面（/cslink/lobby.html、/cslink/duel.html）和正式站共用同一条 socket：
   访客身份、PoW、断线重连都走 api/socket.ts，页面只拿到 rpc / on / onConnect。 */
import { getSocket } from '../api/socket';
import { duelError, type DuelResponse } from '../api/cslinkDuel';

const REQUEST_TIMEOUT_MS = 10_000;
const socket = getSocket();
/* 牌桌页没有挂 React 的 Toast，连接被拒（比如同一身份开太多标签页）要自己告诉页面 */
let lastConnectError = '';
const errorListeners = new Set<(code: string) => void>();
socket.on('connect_error', (error) => {
  lastConnectError = /^[A-Z_]+$/.test(error.message) ? error.message : 'NETWORK_ERROR';
  errorListeners.forEach((listener) => listener(lastConnectError));
});
socket.on('connect', () => { lastConnectError = ''; });

function waitConnected(timeoutMs: number): Promise<boolean> {
  if (socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => { window.clearTimeout(timer); socket.off('connect', onConnect); resolve(ok); };
    const onConnect = () => done(true);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    socket.on('connect', onConnect);
  });
}

async function rpc(event: string, payload: Record<string, unknown> = {}): Promise<DuelResponse> {
  if (!(await waitConnected(REQUEST_TIMEOUT_MS))) return { code: 'NETWORK_ERROR' };
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) { settled = true; resolve({ code: 'REQUEST_TIMEOUT' }); }
    }, REQUEST_TIMEOUT_MS);
    socket.emit(`cslink:${event}`, payload, (response: DuelResponse) => {
      if (settled) return;
      settled = true; window.clearTimeout(timer);
      resolve(response ?? { code: 'REQUEST_TIMEOUT' });
    });
  });
}

const net = {
  rpc,
  on(listener: (response: DuelResponse) => void) {
    socket.on('cslink:state', listener);
    return () => { socket.off('cslink:state', listener); };
  },
  /** 首次连接和每次重连都会触发，页面用它重新 sync */
  onConnect(listener: () => void) {
    socket.on('connect', listener);
    return () => { socket.off('connect', listener); };
  },
  onDisconnect(listener: () => void) {
    socket.on('disconnect', listener);
    return () => { socket.off('disconnect', listener); };
  },
  connected: () => socket.connected,
  onConnectError(listener: (code: string) => void) {
    errorListeners.add(listener);
    if (lastConnectError) listener(lastConnectError);
    return () => { errorListeners.delete(listener); };
  },
  error: duelError,
};

declare global {
  interface Window { CSNET?: typeof net }
}

window.CSNET = net;
window.dispatchEvent(new Event('csnet'));
