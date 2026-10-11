import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import TeammatesMerged from '../../src/pages/TeammatesMerged';
import { MergedMetadata, MergedPlayer, MergedRelationship } from '../../src/api/cslinkMerged';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../src/api/client', () => ({ api: { get: apiGet } }));
const version = '1234567890abcdef1234';
const niko: MergedPlayer = { id: 'hltv:3741', hltvId: '3741', nickname: 'NiKo',
  profileUrl: 'https://www.hltv.org/stats/players/3741/niko', verifiedMapCount: 2, candidateMapCount: 6 };
const lowerNiko: MergedPlayer = { id: 'hltv:10264', hltvId: '10264', nickname: 'niko',
  profileUrl: 'https://www.hltv.org/stats/players/10264/niko', verifiedMapCount: 0, candidateMapCount: 1 };
const jks: MergedPlayer = { id: 'hltv:4679', hltvId: '4679', nickname: 'jks',
  profileUrl: 'https://www.hltv.org/stats/players/4679/jks', verifiedMapCount: 2, candidateMapCount: 6 };
const meta: MergedMetadata = { version, sourceVersions: { verified: 'a'.repeat(20), candidate: 'b'.repeat(20) },
  sourceAvailability: { verified: true, candidate: true }, verifiedMaps: 27,
  rawSampledMaps: 805, sampledMaps: 802, excludedMaps: 3, approvedEvents: 109,
  playScopeApplied: true, candidateScope: 'local_play_approved',
  distinctPlayers: 997, distinctPairs: 3542, example: [niko, jks], coverage: 'partial_sample', eligibleForQuestions: false };
const result: MergedRelationship = { version, playerA: niko, playerB: jks, status: 'confirmed',
  total: 2, verifiedTotal: 1, candidateTotal: 1, offset: 0, hasMore: false, evidence: [
    { mapId: 157818, event: 'IEM Dallas 2023', map: 'Mirage', dateRaw: '2023-05-29 22:50',
      team: 'G2', opponents: ['G2', 'OG'], score: [16, 2],
      sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/157818/g2-vs-og', lineup: [niko, jks],
      reviewState: 'verified', scopeStatus: 'legacy_scope_unreviewed', sourceDataset: 'cslink_review',
      datasetVersion: 'a'.repeat(20), sourceFingerprint: 'c'.repeat(64),
      review: { status: 'verified', reviewedOn: '2026-09-30', reviewedBy: 'assistant' } },
    { mapId: 160037, event: 'BLAST Premier Fall Groups 2023', tier: 'S-Tier', map: 'Inferno',
      dateRaw: '2023-07-14 12:00', team: 'G2', opponents: ['G2', 'NAVI'], score: [16, 10],
      sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/160037/-', lineup: [niko, jks],
      opponentLineup: [lowerNiko], reviewState: 'unreviewed', scopeStatus: 'as_tier_batch_approved',
      sourceDataset: 'hltv_candidate', datasetVersion: 'b'.repeat(20), sourceFingerprint: 'd'.repeat(64) },
  ] };

function response(path: string, options?: any) {
  if (path.endsWith('/meta')) return { data: meta };
  if (path.endsWith('/players')) {
    const search = String(options.params.search).toLowerCase();
    const items = search.includes('jk') ? [jks] : [lowerNiko, niko];
    return { data: { version, items, total: items.length } };
  }
  return { data: result };
}

beforeEach(() => { apiGet.mockReset(); apiGet.mockImplementation(async (path, options) => response(path, options)); });

describe('Combined teammate evidence', () => {
  it('requires numeric identity selection and keeps NiKo separate from niko', async () => {
    const user = userEvent.setup(); renderAtRoute(<TeammatesMerged />);
    const inputs = await screen.findAllByRole('combobox');
    await user.type(inputs[0], 'niko');
    expect(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'niko · HLTV #10264' }));
    await user.type(inputs[1], 'jks');
    await user.click(await screen.findByRole('option', { name: 'jks · HLTV #4679' }));
    await user.click(screen.getByRole('button', { name: '查询同队地图' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/cslink/merged/relationship', expect.objectContaining({
      params: { playerA: 'hltv:10264', playerB: 'hltv:4679', version, offset: 0 },
    })));
  });

  it('keeps the two evidence review states separate and links each HLTV map', async () => {
    renderAtRoute(<TeammatesMerged />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    expect(await screen.findByText('2 张同队地图')).toBeInTheDocument();
    expect(screen.getByText('已复核')).toBeInTheDocument();
    expect(screen.getByText('HLTV 采集 · 未逐图复核')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'HLTV · Mirage' })).toHaveAttribute('href', result.evidence[0].sourceUrl);
    expect(screen.getByRole('link', { name: 'HLTV · Inferno' })).toHaveAttribute('href', result.evidence[1].sourceUrl);
    expect(screen.getByText(/当前收录仍不代表完整历史/)).toBeInTheDocument();
  });

  it('selects a legacy identity and preserves the imported HLTV match evidence without a fake profile', async () => {
    const legacy: MergedPlayer = { id: `legacy:${'a'.repeat(20)}`, hltvId: null, profileUrl: null,
      nickname: 'sameName', identityKind: 'legacy_context', identityContext: 'IEM Katowice 2022',
      verifiedMapCount: 0, candidateMapCount: 0, legacyMapCount: 3 };
    const imported: MergedRelationship = { ...result, playerA: legacy, total: 1, verifiedTotal: 0,
      candidateTotal: 1, evidence: [{ ...result.evidence[0], lineup: [legacy, jks],
        opponentLineup: [legacy], team: '同队五人', reviewState: 'unreviewed',
        sourceDataset: 'legacy_dataset', scopeStatus: 'legacy_as_import', review: undefined }] };
    apiGet.mockImplementation(async (path, options) => {
      if (path.endsWith('/players') && options.params.search === 'sameName') return { data: { version, items: [legacy], total: 1 } };
      if (path.endsWith('/relationship')) return { data: imported };
      return response(path, options);
    });
    const user = userEvent.setup(); renderAtRoute(<TeammatesMerged />);
    const inputs = await screen.findAllByRole('combobox');
    await user.type(inputs[0], 'sameName');
    await user.click(await screen.findByRole('option', { name: 'sameName · 旧库身份 · IEM Katowice 2022' }));
    await user.type(inputs[1], 'jks');
    await user.click(await screen.findByRole('option', { name: 'jks · HLTV #4679' }));
    await user.click(screen.getByRole('button', { name: '查询同队地图' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/cslink/merged/relationship', expect.objectContaining({
      params: { playerA: legacy.id, playerB: jks.id, version, offset: 0 },
    })));
    expect(await screen.findByText('旧库导入 · 未逐图复核')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'HLTV · Mirage' })).toHaveAttribute('href', imported.evidence[0].sourceUrl);
    expect(screen.getByText('同队五人')).toBeInTheDocument();
    expect(screen.getByText(/原始旧数据库导入，未逐图重新抓取/)).toBeInTheDocument();
    expect(screen.queryByText(/#null/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /旧库身份/ })).not.toBeInTheDocument();
  });

  it('treats no loaded evidence as unknown, not a historical negative', async () => {
    apiGet.mockImplementation(async (path, options) => path.endsWith('/relationship') ? { data: {
      ...result, status: 'not_found_in_loaded_data', total: 0, verifiedTotal: 0, candidateTotal: 0, evidence: [],
    } } : response(path, options));
    renderAtRoute(<TeammatesMerged />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    expect(await screen.findByText('当前样本未找到')).toBeInTheDocument();
    expect(screen.getByText(/这不能证明他们从未做过队友/)).toBeInTheDocument();
  });
});
