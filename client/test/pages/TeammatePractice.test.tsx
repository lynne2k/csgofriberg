import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import TeammatePractice from '../../src/pages/TeammatePractice';
import { AnswerExplanation, EvidencePlayer, PracticeQuestion } from '../../src/api/cslink';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { get: apiGet, post: apiPost } }));
const version = '1234567890abcdef1234', bankVersion = 'abcdef1234567890abcd';
const player = (id: number, nickname: string, hltvId: string, name: string): EvidencePlayer => ({
  id: `cs-person-${String(id).padStart(6, '0')}`, nickname, hltvId, name,
  profileUrl: `https://www.hltv.org/player/${hltvId}/fixture`, verifiedMapCount: 2,
});
const niko = player(1, 'NiKo', '3741', 'Nikola Kovač'), lower = player(2, 'niko', '10264', 'Nikolaj Kristensen');
const jks = player(4, 'jks', '4679', 'Justin Savage'), chris = player(11, 'chrisJ', '2730', 'Chris de Jong');
const other = player(3, 'HooXi', '10096', 'Rasmus Nielsen');
const q: PracticeQuestion = { id: '1'.repeat(20), bankVersion, dataVersion: version, playerA: jks, playerB: chris, coverage: 'partial' };
const explanation = (who: EvidencePlayer): AnswerExplanation => {
  const side = (endpoint: EvidencePlayer, mapId: number) => ({ endpoint, evidenceCount: 1, proof: {
    mapId, event: 'Synthetic fixture', map: 'Mirage', dateRaw: '2023-01-01', timezone: 'unknown', team: 'Fixture',
    opponents: ['Fixture', 'Other'], score: [16, 5], sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${mapId}/fixture`,
    lineup: [endpoint, who], review: { status: 'verified' as const, reviewedOn: '2026-10-03', reviewedBy: 'fixture' },
    recordSha256: 'a'.repeat(64), sourceRefs: { details: [{ file: 'fixture.csv', csv_record: 2 }] },
  } });
  return { player: who, left: side(jks, 990001), right: side(chris, 990002) };
};
function get(path: string, options?: any) {
  if (path.endsWith('/meta')) return { data: { bankVersion, dataVersion: version, total: 10, bridge: 5, multiple: 5,
    mode: 'local_practice', coverage: 'partial', releaseReady: false, rightsStatus: 'unconfirmed',
    verifiedDateRangeRaw: { first: '2012-01-01', last: '2023-01-01' } } };
  if (path.endsWith('/question')) return { data: { ...q, id: options?.params?.previous ? '2'.repeat(20) : q.id } };
  if (path.includes('/question/')) return { data: q };
  return { data: { version, total: 2, items: options.params.search.includes('Hoo') ? [other] : [niko, lower] } };
}
beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset(); apiGet.mockImplementation(async (path, options) => get(path, options));
  apiPost.mockImplementation(async (path, body) => path.endsWith('/reveal') ? { data: {
    questionId: q.id, bankVersion, coverage: 'partial', answers: [explanation(niko), explanation(other)],
  } } : { data: { questionId: q.id, bankVersion,
    player: body.playerId === lower.id ? lower : body.playerId === other.id ? other : niko,
    status: body.playerId === lower.id ? 'not_confirmed' : 'accepted',
    explanation: body.playerId === lower.id ? null : explanation(body.playerId === other.id ? other : niko) } });
});
async function choose(nickname: string, accessible: RegExp) {
  const input = await screen.findByRole('combobox', { name: '你的答案' });
  await userEvent.clear(input); await userEvent.type(input, nickname);
  await userEvent.click(await screen.findByRole('option', { name: accessible }));
}

describe('local common-teammate practice', () => {
  it('opens a fixed question link without fetching a random question or exposing answers', async () => {
    renderAtRoute(<TeammatePractice />, {
      route: `/teammates/practice/legacy?question=${q.id}&version=${bankVersion}`, path: '/teammates/practice/legacy',
    });
    expect(await screen.findByRole('link', { name: '固定这道题的链接' })).toHaveAttribute(
      'href', `/teammates/practice/legacy?question=${q.id}&version=${bankVersion}`,
    );
    expect(apiGet).toHaveBeenCalledWith(`/cslink/practice/question/${q.id}`, expect.objectContaining({
      params: { bankVersion },
    }));
    expect(apiGet).not.toHaveBeenCalledWith('/cslink/practice/question', expect.anything());
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
  });
  it('requires an explicit identity and submits the chosen stable ID with a pinned question version', async () => {
    renderAtRoute(<TeammatePractice />);
    const input = await screen.findByRole('combobox', { name: '你的答案' });
    await userEvent.type(input, 'niko');
    expect(await screen.findByRole('option', { name: /NiKo Nikola/ })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '验证答案' })).toBeDisabled();
    await userEvent.click(screen.getByRole('option', { name: /niko Nikolaj/ }));
    await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(apiPost).toHaveBeenCalledWith('/cslink/practice/answer', {
      questionId: q.id, bankVersion, playerId: lower.id,
    }, expect.anything());
    expect(await screen.findByText(/niko：当前库尚未证实两侧关系/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
  });
  it('accepts additional answers and shows a source link for each side without counting duplicates', async () => {
    renderAtRoute(<TeammatePractice />);
    await choose('NiKo', /NiKo Nikola/); await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(await screen.findByRole('heading', { name: '已找到 1 个答案' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '查看 HLTV 地图 #990001' })).toHaveAttribute('href', explanation(niko).left.proof.sourceUrl);
    expect(screen.getByRole('link', { name: '查看 HLTV 地图 #990002' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: '验证答案' })).toBeDisabled();
    await choose('HooXi', /HooXi Rasmus/); await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(await screen.findByRole('heading', { name: '已找到 2 个答案' })).toBeInTheDocument();
  });
  it('reveals all known answers only on request and resets them when switching mode', async () => {
    renderAtRoute(<TeammatePractice />);
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: '查看当前库全部答案' }));
    expect(await screen.findByRole('heading', { name: '当前库已证实的 2 个答案' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '你的答案' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '练习模式' }), 'multiple');
    expect(await screen.findByRole('combobox', { name: '你的答案' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/cslink/practice/question', expect.objectContaining({ params: { pool: 'multiple', previous: q.id } }));
  });
  it('ignores a late answer after the user has moved to another question', async () => {
    let resolve!: (value: unknown) => void;
    apiPost.mockImplementation(() => new Promise(r => { resolve = r; }));
    renderAtRoute(<TeammatePractice />);
    await choose('NiKo', /NiKo Nikola/); await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    await userEvent.click(screen.getByRole('button', { name: '换一道题' }));
    await screen.findByRole('combobox', { name: '你的答案' });
    await act(async () => { resolve({ data: { status: 'accepted', player: niko, explanation: explanation(niko) } }); });
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '你的答案' })).toHaveValue('');
  });
  it('handles version changes explicitly and allows a fresh question', async () => {
    apiPost.mockRejectedValue({ response: { data: { code: 'CSLINK_VERSION_CHANGED' } } });
    renderAtRoute(<TeammatePractice />);
    await userEvent.click(await screen.findByRole('button', { name: '查看当前库全部答案' }));
    await userEvent.click(await screen.findByRole('button', { name: '更新题库并重新开始' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(await screen.findByRole('combobox', { name: '你的答案' })).toHaveValue('');
  });
});
