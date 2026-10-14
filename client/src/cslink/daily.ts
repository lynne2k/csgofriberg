/* 单人每日挑战页（/cslink/daily.html、首页 /cslink/）调用的接口：
   走正式站同一个 axios 实例，访客身份、PoW、登录态都和 React 页面一致。 */
import axios from 'axios';
import { api } from '../api/client';
import { getNickname } from './nick';

async function call<T = any>(method: 'get' | 'post', url: string, body?: unknown): Promise<T> {
  try {
    const res = method === 'get' ? await api.get(url, { params: body }) : await api.post(url, body ?? {});
    return res.data as T;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) return error.response.data as T;
    return { code: 'NETWORK_ERROR' } as T;
  }
}

/* 写操作都带上本机昵称；没起昵称时不带，服务端显示访客编号 */
const withNick = <T extends object>(body: T) => ({ ...body, ...(getNickname() ? { nickname: getNickname() } : {}) });
const daily = {
  today: () => call('get', '/cslink/daily/today'),
  start: () => call('post', '/cslink/daily/start', withNick({})),
  begin: () => call('post', '/cslink/daily/begin', withNick({})),
  submit: (input: { date: string; dataVersion: string; routeIds: string[] }) => call('post', '/cslink/daily/submit', withNick(input)),
  leaderboard: (limit = 10) => call('get', '/cslink/daily/leaderboard', { limit }),
};

declare global {
  interface Window { CSDAILY?: typeof daily }
}

window.CSDAILY = daily;
window.dispatchEvent(new Event('csdaily'));
