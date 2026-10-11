import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import Search from '../../src/pages/Search';

vi.mock('../../src/api/client', () => ({ api: { get: async () => ({ data: [
  { id: 1, nickname: 'NiKo', isActive: true, age: 29 },
  { id: 2, nickname: 'niko', isActive: false, age: 28 },
] }) }, errMsg: () => 'error' }));
vi.mock('../../src/components/GuessInputBar', () => ({ default: ({ onPick }: any) =>
  <button onClick={() => onPick({ id: 2, nickname: 'niko' })}>选择丹麦 niko</button> }));
vi.mock('../../src/components/AnswerOverlay', () => ({ PlayerInfoTable: ({ answer }: any) => <p>选手编号对应：{answer.nickname}</p> }));

it('keeps the explicitly selected player ID instead of choosing a case-folded nickname match', async () => {
  renderAtRoute(<Search />);
  await userEvent.click(screen.getByRole('button', { name: '选择丹麦 niko' }));
  expect(await screen.findByText('选手编号对应：niko')).toBeInTheDocument();
  expect(screen.queryByText('选手编号对应：NiKo')).not.toBeInTheDocument();
});
