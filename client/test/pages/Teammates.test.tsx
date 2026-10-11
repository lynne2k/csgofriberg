import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import Teammates from '../../src/pages/Teammates';
import { EvidenceMetadata, EvidencePlayer, RelationshipResult } from '../../src/api/cslink';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../src/api/client', () => ({ api: { get: apiGet } }));
const version = '1234567890abcdef1234';
const niko: EvidencePlayer = { id: 'cs-person-000001', nickname: 'NiKo', name: 'Nikola Kovač', hltvId: '3741',
  profileUrl: 'https://www.hltv.org/player/3741/niko', verifiedMapCount: 2 };
const lowerNiko: EvidencePlayer = { ...niko, id: 'cs-person-000002', nickname: 'niko', name: 'Nikolaj Kristensen',
  hltvId: '10264', profileUrl: 'https://www.hltv.org/player/10264/niko' };
const jks: EvidencePlayer = { ...niko, id: 'cs-person-000004', nickname: 'jks', name: 'Justin Savage', hltvId: '4679',
  profileUrl: 'https://www.hltv.org/stats/players/4679/jks' };
const meta: EvidenceMetadata = { version, mode: 'local_review', coverage: 'partial', rightsStatus: 'unconfirmed',
  registeredPlayers: 3, verifiedMaps: 2, verifiedDateRangeRaw: { first: null, last: null }, example: [niko, jks] };
const result: RelationshipResult = { version, coverage: 'partial', playerA: niko, playerB: jks, status: 'confirmed',
  total: 1, offset: 0, hasMore: false, evidence: [{ mapId: 157818, event: 'IEM Dallas 2023', map: 'Mirage',
    dateRaw: '2023-05-29 22:50:00', timezone: 'unspecified_in_source', team: 'G2', opponents: ['G2', 'OG'], score: [16, 2],
    sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/157818/g2-vs-og', lineup: [niko, jks],
    review: { status: 'verified', reviewedOn: '2026-09-30', reviewedBy: 'assistant' }, recordSha256: 'a'.repeat(64),
    sourceRefs: { details: [{ file: 'fixture.csv', csv_record: 2 }] },
  }] };
function response(path: string, options?: any) {
  if (path.endsWith('/meta')) return { data: meta };
  if (path.endsWith('/players')) return { data: { version, items: options.params.search.toLowerCase().includes('jk') ? [jks] : [lowerNiko, niko], total: options.params.search.toLowerCase().includes('jk') ? 1 : 2 } };
  return { data: result };
}
beforeEach(() => { apiGet.mockReset(); apiGet.mockImplementation(async (path, options) => response(path, options)); });

describe('Teammate evidence selection and provenance', () => {
  it('requires explicit identity choice and sends IDs, keeping NiKo and niko distinct', async () => {
    const user = userEvent.setup(); renderAtRoute(<Teammates />);
    const inputs = await screen.findAllByRole('combobox');
    await user.type(inputs[0], 'niko');
    expect(await screen.findByRole('option', { name: /NiKo Nikola Kovač.*3741/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /niko Nikolaj Kristensen.*10264/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: '查询同队证据' })).toBeDisabled();
    await user.click(screen.getByRole('option', { name: /niko Nikolaj Kristensen.*10264/ }));
    await user.type(inputs[1], 'jks');
    await user.click(await screen.findByRole('option', { name: /jks Justin Savage.*4679/ }));
    await user.click(screen.getByRole('button', { name: '查询同队证据' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/cslink/relationship', expect.objectContaining({
      params: { playerA: lowerNiko.id, playerB: jks.id, version, offset: 0 },
    })));
  });
  it('shows a usable HLTV source link and expandable provenance for the chosen pair', async () => {
    renderAtRoute(<Teammates />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    const link = await screen.findByRole('link', { name: 'HLTV · Mirage' });
    expect(link).toHaveAttribute('href', result.evidence[0].sourceUrl);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('heading', { name: 'IEM Dallas 2023' })).toBeInTheDocument();
    await userEvent.click(screen.getByText('查看复核记录'));
    expect(screen.getByText('fixture.csv · CSV 记录 2')).toBeVisible();
    expect(screen.getByText('a'.repeat(64))).toBeVisible();
  });
  it('uses qualified wording when the reviewed dataset contains no relationship', async () => {
    apiGet.mockImplementation(async (path, options) => path.endsWith('/relationship') ? { data: { ...result,
      total: 0, status: 'not_found_in_reviewed_data', evidence: [] } } : response(path, options));
    renderAtRoute(<Teammates />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    expect(await screen.findByText('当前库未找到证据')).toBeInTheDocument();
    expect(screen.getByText('这不代表他们从未做过队友。历史比赛和选手身份仍在补充。')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /HLTV ·/ })).not.toBeInTheDocument();
  });
  it('discards an in-flight relationship when either input is edited', async () => {
    let resolve!: (value: unknown) => void;
    apiGet.mockImplementation((path, options) => path.endsWith('/relationship') ? new Promise(r => { resolve = r; }) : Promise.resolve(response(path, options)));
    renderAtRoute(<Teammates />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    await userEvent.clear(screen.getByRole('combobox', { name: '第一名选手' }));
    await act(async () => { resolve({ data: result }); });
    expect(screen.queryByRole('region', { name: '关系查询结果' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查询同队证据' })).toBeDisabled();
  });
  it('does not replace new search results with a late response from the old input', async () => {
    let resolve!: (value: unknown) => void;
    apiGet.mockImplementation((path, options) => path.endsWith('/players') && options.params.search === 'ni'
      ? new Promise(r => { resolve = r; }) : Promise.resolve(response(path, options)));
    renderAtRoute(<Teammates />);
    const input = (await screen.findAllByRole('combobox'))[0];
    await userEvent.type(input, 'ni');
    await waitFor(() => expect(resolve).toBeDefined());
    await userEvent.clear(input); await userEvent.type(input, 'jk');
    expect(await screen.findByRole('option', { name: /jks Justin/ })).toBeInTheDocument();
    await act(async () => { resolve({ data: { version, items: [niko], total: 1 } }); });
    expect(screen.queryByRole('option', { name: /NiKo Nikola/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /jks Justin/ })).toBeInTheDocument();
  });
  it('offers a retry after a failed query and a version refresh after a changed dataset', async () => {
    let attempts = 0;
    apiGet.mockImplementation(async (path, options) => {
      if (path.endsWith('/relationship') && attempts++ === 0) throw new Error('offline');
      if (path.endsWith('/relationship') && attempts === 2) throw { response: { data: { code: 'CSLINK_VERSION_CHANGED' } } };
      return response(path, options);
    });
    renderAtRoute(<Teammates />);
    await userEvent.click(await screen.findByRole('button', { name: '试试 NiKo + jks' }));
    await userEvent.click(await screen.findByRole('button', { name: '重试查询' }));
    await userEvent.click(await screen.findByRole('button', { name: '更新数据版本' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '第一名选手' })).toHaveValue(''));
    expect(screen.getByRole('button', { name: '查询同队证据' })).toBeDisabled();
  });
});
