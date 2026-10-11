import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import TeammatePlay from '../../src/pages/TeammatePlay';
import type { PlayExplanation, PlayPlayer } from '../../src/api/cslinkPlay';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { get: apiGet, post: apiPost } }));

const dataVersion = 'a'.repeat(20), bankVersion = 'b'.repeat(20);
const player = (id: number, nickname: string): PlayPlayer => ({
  id: `hltv:${id}`, hltvId: String(id), nickname,
  profileUrl: `https://www.hltv.org/player/${id}/fixture`, verifiedMapCount: 0, candidateMapCount: 2,
});
const niko = player(3741, 'NiKo'), lower = player(10264, 'niko');
const jks = player(4679, 'jks'), chris = player(2730, 'chrisJ');
const question = { id: 'c'.repeat(20), bankVersion, dataVersion, playerA: jks, playerB: chris, coverage: 'approved_as_tier_sample' };
const proof = (endpoint: PlayPlayer, answer: PlayPlayer, mapId: number) => ({
  endpoint, evidenceCount: 1,
  proof: { mapId, event: 'Fixture event', eventUrl: 'https://www.hltv.org/events/1/fixture', tier: 'S',
    map: 'Mirage', dateRaw: '2024-01-01', team: 'Fixture', opponents: ['Fixture', 'Other'], score: [13, 5],
    sourceUrl: `https://www.hltv.org/stats/matches/mapstatsid/${mapId}/fixture`, lineup: [endpoint, answer],
    reviewState: 'unreviewed' as const, sourceFingerprint: 'd'.repeat(64),
    sourceDataset: 'hltv_candidate', scopeApproval: 'user_batch_scope_approval' as const },
});
const explanation: PlayExplanation = { player: niko, left: proof(jks, niko, 900001), right: proof(chris, niko, 900002) };

beforeEach(() => {
  apiGet.mockReset(); apiPost.mockReset();
  apiGet.mockImplementation(async (path, options) => {
    if (path === '/cslink/play/meta') return { data: { bankVersion, dataVersion, total: 12000, bridge: 10000,
      multiple: 4000, sampledMaps: 802, approvedEvents: 109, sourceVersions: { candidate: 'x', verified: 'y' },
      approval: { kind: 'user_batch_scope_approval', individualMapReview: 'not_performed' },
      mode: 'local_play', coverage: 'approved_as_tier_sample', reviewState: 'mixed_or_unreviewed' } };
    if (path === '/cslink/play/question' || path.startsWith('/cslink/play/question/')) return { data: question };
    if (path === '/cslink/play/players') return { data: { version: dataVersion, total: 2, items: [niko, lower] } };
    throw new Error(`Unexpected GET ${path} ${JSON.stringify(options)}`);
  });
  apiPost.mockImplementation(async (path, body) => {
    if (path === '/cslink/play/answer') return { data: { questionId: question.id, bankVersion,
      player: body.playerId === lower.id ? lower : niko,
      status: body.playerId === lower.id ? 'not_confirmed' : 'accepted',
      explanation: body.playerId === lower.id ? null : explanation } };
    if (path === '/cslink/play/reveal') return { data: { questionId: question.id, bankVersion,
      coverage: 'approved_as_tier_sample', answers: [explanation] } };
    throw new Error(`Unexpected POST ${path}`);
  });
});

describe('approved local play graph', () => {
  it('distinguishes NiKo and niko by HLTV ID and keeps unreviewed map provenance visible', async () => {
    renderAtRoute(<TeammatePlay />, { route: '/teammates/practice', path: '/teammates/practice' });
    const input = await screen.findByRole('combobox', { name: '你的答案' });
    await userEvent.type(input, 'niko');
    expect(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'niko · HLTV #10264' }));
    await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(apiPost).toHaveBeenCalledWith('/cslink/play/answer', {
      questionId: question.id, bankVersion, playerId: 'hltv:10264',
    }, expect.anything());
    expect(await screen.findByText(/当前关系库尚未找到两侧证据/)).toBeInTheDocument();
    await userEvent.clear(input); await userEvent.type(input, 'NiKo');
    await userEvent.click(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' }));
    await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(await screen.findByRole('link', { name: 'HLTV 地图 #900001' })).toHaveAttribute('href', explanation.left.proof.sourceUrl);
    await userEvent.click(screen.getAllByText('证据来源详情')[0]);
    expect(screen.getAllByText('已采集，未逐图人工复核')).toHaveLength(2);
  });

  it('submits a legacy internal ID and shows its imported match links and context', async () => {
    const legacy: PlayPlayer = { id: `legacy:${'e'.repeat(20)}`, nickname: 'legacyPlayer',
      hltvId: null, profileUrl: null, identityKind: 'legacy_context', identityContext: 'IEM Katowice 2022',
      verifiedMapCount: 0, candidateMapCount: 0, legacyMapCount: 2 };
    const legacyEndpoint = { ...legacy, id: `legacy:${'f'.repeat(20)}`, nickname: 'legacyEndpoint' };
    const imported: PlayExplanation = { player: legacy, left: proof(legacyEndpoint, legacy, 901001), right: proof(chris, legacy, 901002) };
    for (const side of [imported.left, imported.right]) {
      side.proof.sourceDataset = 'legacy_dataset';
      side.proof.scopeApproval = 'user_requested_legacy_import';
      side.proof.team = '同队五人';
    }
    const originalGet = apiGet.getMockImplementation()!;
    apiGet.mockImplementation(async (path, options) => {
      if (path === '/cslink/play/question') return { data: { ...question, playerA: legacyEndpoint } };
      if (path === '/cslink/play/players') return { data: { version: dataVersion, total: 1, items: [legacy] } };
      return originalGet(path, options);
    });
    apiPost.mockResolvedValue({ data: { questionId: question.id, bankVersion,
      player: legacy, status: 'accepted', explanation: imported } });
    renderAtRoute(<TeammatePlay />, { route: '/teammates/practice', path: '/teammates/practice' });
    const input = await screen.findByRole('combobox', { name: '你的答案' });
    await userEvent.type(input, 'legacyPlayer');
    await userEvent.click(await screen.findByRole('option', { name: 'legacyPlayer · 旧库身份 · IEM Katowice 2022' }));
    await userEvent.click(screen.getByRole('button', { name: '验证答案' }));
    expect(apiPost).toHaveBeenCalledWith('/cslink/play/answer', {
      questionId: question.id, bankVersion, playerId: legacy.id,
    }, expect.anything());
    expect(await screen.findByRole('link', { name: 'HLTV 地图 #901001' })).toHaveAttribute('href', imported.left.proof.sourceUrl);
    expect(screen.getByRole('link', { name: 'HLTV 地图 #901002' })).toHaveAttribute('href', imported.right.proof.sourceUrl);
    expect(screen.getAllByText('旧库导入 · 未逐图重新抓取')).toHaveLength(2);
    expect(screen.queryByText(/#null/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /旧库身份/ })).not.toBeInTheDocument();
  });

  it('opens version-pinned questions without leaking the answer until requested', async () => {
    renderAtRoute(<TeammatePlay />, { route: `/teammates/practice?question=${question.id}&version=${bankVersion}`, path: '/teammates/practice' });
    expect(await screen.findByRole('link', { name: '固定这道题的链接' })).toHaveAttribute('href',
      `/teammates/practice?question=${question.id}&version=${bankVersion}`);
    expect(apiGet).toHaveBeenCalledWith(`/cslink/play/question/${question.id}`, expect.objectContaining({ params: { bankVersion } }));
    expect(screen.queryByRole('region', { name: '答案与证据' })).not.toBeInTheDocument();
  });
});
