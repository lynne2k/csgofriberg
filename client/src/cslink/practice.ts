/* 练习页（/cslink/practice.html）调用的接口：随机出题、校验路线、放弃后给参考答案。不计分。 */
import axios from 'axios';
import { api } from '../api/client';

async function call<T = any>(method: 'get' | 'post', url: string, body?: unknown): Promise<T> {
  try {
    const res = method === 'get' ? await api.get(url, { params: body }) : await api.post(url, body ?? {});
    return res.data as T;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.data) return error.response.data as T;
    return { code: 'NETWORK_ERROR' } as T;
  }
}

type Pair = { startId: string; endId: string; dataVersion: string };
const practice = {
  question: (difficulty: string) => call('get', '/cslink/drill/question', { difficulty }),
  submit: (input: Pair & { routeIds: string[] }) => call('post', '/cslink/drill/submit', input),
  reveal: (input: Pair) => call('post', '/cslink/drill/reveal', input),
};

declare global {
  interface Window { CSPRACTICE?: typeof practice }
}

window.CSPRACTICE = practice;
window.dispatchEvent(new Event('cspractice'));
