import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import TeammateLibrary from '../../src/pages/TeammateLibrary';
import { CandidateMetadata, CandidatePlayer, CandidateRelationship } from '../../src/api/cslinkCandidates';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../src/api/client', () => ({ api: { get: apiGet } }));
const version = '1234567890abcdef1234';
const niko: CandidatePlayer = { id: 'hltv:3741', hltvId: '3741', nickname: 'NiKo',
  profileUrl: 'https://www.hltv.org/stats/players/3741/niko', evidenceMapCount: 49 };
const lowerNiko: CandidatePlayer = { id: 'hltv:10264', hltvId: '10264', nickname: 'niko',
  profileUrl: 'https://www.hltv.org/stats/players/10264/niko', evidenceMapCount: 3 };
const hunter: CandidatePlayer = { id: 'hltv:3972', hltvId: '3972', nickname: 'huNter-',
  profileUrl: 'https://www.hltv.org/stats/players/3972/hunter', evidenceMapCount: 50 };
const meta: CandidateMetadata = { version, mode: 'candidate_review', coverage: 'sampled',
  capturedMaps: 805, distinctPlayers: 838, candidatePairs: 3198, reviewState: 'unreviewed', eligibleForQuestions: false };
const relationship: CandidateRelationship = { version, coverage: 'sampled', playerA: niko, playerB: hunter,
  status: 'candidate_evidence', total: 1, offset: 0, hasMore: false, evidence: [{
    mapId: 160037, event: 'BLAST Premier: Fall Groups 2023',
    eventUrl: 'https://liquipedia.net/counterstrike/BLAST/Premier/2023/Fall/Groups', tier: 'S-Tier', map: 'Inferno',
    dateRaw: '2023-07-23 23:40', team: 'G2', opponents: ['Natus Vincere', 'G2'], score: [16, 14],
    sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/160037/-',
    lineup: [niko, hunter], opponentLineup: [lowerNiko], reviewState: 'unreviewed', captureSha256: 'a'.repeat(64),
  }] };

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (path: string, options?: { params?: { search?: string } }) => {
    if (path.endsWith('/meta')) return { data: meta };
    if (path.endsWith('/players')) {
      const search = options?.params?.search?.toLowerCase() ?? '';
      const items = search.includes('hunt') ? [hunter] : [lowerNiko, niko];
      return { data: { version, items, total: items.length } };
    }
    return { data: relationship };
  });
});

describe('Candidate teammate library', () => {
  it('keeps similarly named players separate and queries explicit numeric identities', async () => {
    const user = userEvent.setup(); renderAtRoute(<TeammateLibrary />);
    const inputs = await screen.findAllByRole('combobox');
    await user.type(inputs[0], 'niko');
    expect(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'niko · HLTV #10264' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'NiKo · HLTV #3741' }));
    await user.type(inputs[1], 'hunter');
    await user.click(await screen.findByRole('option', { name: 'huNter- · HLTV #3972' }));
    await user.click(screen.getByRole('button', { name: '查询采样证据' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/cslink/candidates/relationship', expect.objectContaining({
      params: { playerA: 'hltv:3741', playerB: 'hltv:3972', version, offset: 0 },
    })));
    expect(await screen.findByRole('link', { name: 'HLTV · Inferno' })).toHaveAttribute('href', relationship.evidence[0].sourceUrl);
    expect(screen.getByText('待人工复核；仅为候选关系')).toBeInTheDocument();
  });

  it('does not present missing sampled evidence as a historical negative', async () => {
    apiGet.mockImplementation(async (path: string, options?: { params?: { search?: string } }) => {
      if (path.endsWith('/relationship')) return { data: { ...relationship, total: 0, status: 'not_found_in_sample', evidence: [] } };
      if (path.endsWith('/meta')) return { data: meta };
      const items = options?.params?.search?.toLowerCase().includes('hunt') ? [hunter] : [niko];
      return { data: { version, items, total: items.length } };
    });
    const user = userEvent.setup(); renderAtRoute(<TeammateLibrary />);
    const inputs = await screen.findAllByRole('combobox');
    await user.type(inputs[0], 'niko');
    await user.click(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' }));
    await user.type(inputs[1], 'hunter');
    await user.click(await screen.findByRole('option', { name: 'huNter- · HLTV #3972' }));
    await user.click(screen.getByRole('button', { name: '查询采样证据' }));
    expect(await screen.findByText('首轮样本未找到')).toBeInTheDocument();
    expect(screen.getByText('这不能证明他们从未做过队友；同届其他地图与阵容变化仍需补查。')).toBeInTheDocument();
  });
});
