import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../src/api/client';
import i18n from '../../../src/i18n';
import { renderWithProviders } from '../../render';
import { toast } from '../../../src/components/Toast';
import AdminPlayers from '../../../src/components/admin/AdminPlayers';

vi.mock('../../../src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

vi.mock('../../../src/components/Toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('AdminPlayers', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
  });

  it('edits a role without submitting database metadata', async () => {
    const editable = {
      nickname: 'cmtry', nationality: '乌克兰', region: '欧洲',
      team: 'Astralis', team_history: ['Taipan', 'NAVI Junior', 'FUT'],
      age: 19, role: 'AWPer', major_championships: 0,
      major_appearances: 1, difficulties: ['normal'],
      is_active: true, is_enabled: true,
    };
    const row = { ...editable, id: 179, created_at: '2026-08-17 15:34:07' };
    vi.mocked(api.get).mockResolvedValue({
      data: { players: [row], total: 1, page: 1, pageSize: 50, totalPages: 1 },
    } as never);
    vi.mocked(api.put).mockResolvedValue({ data: { ok: true } } as never);
    const user = userEvent.setup();
    renderWithProviders(<AdminPlayers />);
    await user.click(await screen.findByRole('button', { name: '编辑' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '选手位置' }), 'Rifler');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/admin/players/179', {
      ...editable, role: 'Rifler',
    }));
    expect(toast.success).toHaveBeenCalledWith(i18n.t('admin.saved'));
  });

  it('downloads the complete import-compatible player JSON', async () => {
    const exportedPlayers = [{
      nickname: 'export-player',
      nationality: '中国',
      region: '亚洲',
      team: 'Test',
      team_history: ['Old Test'],
      age: 24,
      role: 'Rifler',
      major_championships: 0,
      major_appearances: 1,
      difficulties: ['easy', 'normal'],
      is_active: true,
      is_enabled: true,
    }];
    vi.mocked(api.get).mockImplementation(async (url) => {
      if (url === '/admin/players/export') return { data: exportedPlayers } as never;
      return {
        data: { players: [], total: 0, page: 1, pageSize: 50, totalPages: 1 },
      } as never;
    });
    const createObjectURL = vi.fn(() => 'blob:players');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const user = userEvent.setup();
    renderWithProviders(<AdminPlayers />);
    await screen.findByText('0 条');
    await user.click(screen.getByRole('button', { name: '导出 JSON' }));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/players/export'));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:players');
    expect(toast.success).toHaveBeenCalledWith('已导出 1 名选手');
  });
});
