import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import CsLinkDuel from '../../src/pages/CsLinkDuel';
import type { DuelFinish, DuelResponse, DuelRoom } from '../../src/api/cslinkDuel';
import { parseDuelRoomInput } from '../../src/api/cslinkDuel';
import type { PlayPlayer } from '../../src/api/cslinkPlay';

const { socket, apiGet } = vi.hoisted(() => ({
  socket: { connected: true, handlers: new Map<string, (...args: any[]) => void>(), on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  apiGet: vi.fn(),
}));
vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));
vi.mock('../../src/api/client', () => ({ api: { get: apiGet } }));

const player = (id: number, nickname: string): PlayPlayer => ({ id: `hltv:${id}`, hltvId: String(id), nickname,
  profileUrl: `https://www.hltv.org/player/${id}/fixture`, verifiedMapCount: 0, candidateMapCount: 1 });
const start = player(1, 'start'), end = player(2, 'end'), niko = player(3741, 'NiKo'), lower = player(10264, 'niko');
const legacy: PlayPlayer = { ...player(3, 'oldPlayer'), id: `legacy:${'a'.repeat(20)}`, hltvId: null, profileUrl: null,
  identityKind: 'legacy_context', identityContext: 'ESWC 2012', legacyMapCount: 1 };
const createRoom = (): DuelRoom => ({ id: 'L12345', revision: 1, status: 'lobby', hostKey: 'me', maxPlayers: 2,
  durationSeconds: 60, players: [{ key: 'me', name: 'Alice', ready: false, connected: true, left: false, best: null },
    { key: 'friend', name: 'Bob', ready: false, connected: true, left: false, best: null }],
  round: null, myBest: null, result: null });
const playingRoom = (): DuelRoom => ({ ...createRoom(), status: 'playing', revision: 4,
  round: { roundId: 'round-1', dataVersion: 'v1', start, end, serverStartedAtMs: Date.now() - 5_000,
    serverDeadlineAtMs: Date.now() + 55_000, maxJumps: 16 } });
const finish = (): DuelFinish => ({ roundId: 'round-1', dataVersion: 'v1', startId: start.id, endId: end.id,
  routeIds: [start.id, niko.id, end.id], route: [start, niko, end], jumps: 2,
  serverCompletedAtMs: Date.now(), elapsedMs: 8_000,
  hops: [{ fromId: start.id, toId: niko.id, evidence: { mapId: 13311,
    sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/13311/fixture', evidenceCount: 2, recordSha256: 'a'.repeat(64) } },
  { fromId: niko.id, toId: end.id, evidence: { mapId: 13312,
    sourceUrl: 'https://www.hltv.org/stats/matches/mapstatsid/13312/fixture', evidenceCount: 1, recordSha256: 'b'.repeat(64) } }] });
let currentRoom: DuelRoom | null;
let serverClock: number;
const envelope = (room = currentRoom): DuelResponse => ({ room: structuredClone(room), meKey: 'me', serverNowMs: ++serverClock });
const push = (room: DuelRoom) => { currentRoom = room; act(() => socket.handlers.get('cslink:state')?.(envelope())); };
const renderRoom = (route = '/teammates/duel/L12345') => renderAtRoute(<CsLinkDuel />, { route, path: '/teammates/duel/:roomId?' });

beforeEach(() => {
  currentRoom = null; serverClock = Date.now(); socket.connected = true;
  socket.handlers.clear(); socket.on.mockReset(); socket.off.mockReset(); socket.emit.mockReset(); apiGet.mockReset();
  socket.on.mockImplementation((event: string, handler: (...args: any[]) => void) => { socket.handlers.set(event, handler); });
  socket.off.mockImplementation((event: string, handler: (...args: any[]) => void) => {
    if (socket.handlers.get(event) === handler) socket.handlers.delete(event);
  });
  socket.emit.mockImplementation((event, _body, ack) => {
    if (event === 'cslink:sync') ack(envelope());
    else ack({ ...envelope(), code: 'VALIDATION_FAILED' });
  });
  apiGet.mockResolvedValue({ data: { version: 'v1', total: 3, items: [niko, lower, legacy] } });
});

describe('CS Link path rooms', () => {
  it('creates a timed room, waits for everyone to prepare, then starts the shared round', async () => {
    const original = socket.emit.getMockImplementation()!;
    socket.emit.mockImplementation((event, body, ack) => {
      if (event === 'cslink:create') { currentRoom = { ...createRoom(), durationSeconds: body.durationSeconds, maxPlayers: body.maxPlayers }; ack(envelope()); }
      else if (event === 'cslink:ready') { currentRoom!.players[0].ready = body.ready; currentRoom!.revision++; ack(envelope()); }
      else if (event === 'cslink:start') { currentRoom = playingRoom(); ack(envelope()); }
      else original(event, body, ack);
    });
    renderRoom('/teammates/duel');
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连通房间' })).toBeEnabled());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '每局时长' }), '60');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '人数上限' }), '4');
    await userEvent.click(screen.getByRole('button', { name: '创建连通房间' }));
    expect(socket.emit).toHaveBeenCalledWith('cslink:create', { durationSeconds: 60, maxPlayers: 4 }, expect.any(Function));
    await screen.findByRole('region', { name: '房间准备' });
    expect(screen.getByRole('button', { name: '开始对战' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '准备' }));
    expect(await screen.findByRole('button', { name: '取消准备' })).toBeEnabled();
    currentRoom!.players[1].ready = true; currentRoom!.revision++;
    push(structuredClone(currentRoom!));
    await userEvent.click(screen.getByRole('button', { name: '开始对战' }));
    expect(await screen.findByRole('region', { name: '编辑你的路径' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: '每跳比赛证据' })).not.toBeInTheDocument();
  });

  it('joins a room from a shared URL and leaves explicitly', async () => {
    const original = socket.emit.getMockImplementation()!;
    socket.emit.mockImplementation((event, body, ack) => {
      if (event === 'cslink:join') { currentRoom = createRoom(); ack(envelope()); }
      else if (event === 'cslink:leave') { currentRoom = null; ack(envelope()); }
      else original(event, body, ack);
    });
    renderRoom('/teammates/duel');
    await userEvent.type(screen.getByRole('textbox', { name: '房间号或分享链接' }), 'http://localhost:5173/teammates/duel/L12345');
    await userEvent.click(screen.getByRole('button', { name: '加入房间' }));
    expect(socket.emit).toHaveBeenCalledWith('cslink:join', { roomId: 'L12345' }, expect.any(Function));
    await userEvent.click(await screen.findByRole('button', { name: '退出房间' }));
    expect(await screen.findByRole('button', { name: '创建连通房间' })).toBeInTheDocument();
  });

  it('only adds an explicitly selected player and submits distinct NiKo, niko and legacy IDs', async () => {
    currentRoom = playingRoom();
    renderRoom();
    const input = await screen.findByRole('combobox', { name: '添加中间选手' });
    await userEvent.type(input, 'niko');
    await userEvent.click(await screen.findByRole('option', { name: 'NiKo · HLTV #3741' }));
    expect(within(screen.getByRole('list', { name: '当前路径' })).queryByText('NiKo')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '加入路径' }));
    await userEvent.type(input, 'niko');
    await userEvent.click(await screen.findByRole('option', { name: 'niko · HLTV #10264' }));
    await userEvent.click(screen.getByRole('button', { name: '加入路径' }));
    await userEvent.type(input, 'oldPlayer');
    await userEvent.click(await screen.findByRole('option', { name: 'oldPlayer · 旧库身份 · ESWC 2012' }));
    await userEvent.click(screen.getByRole('button', { name: '加入路径' }));
    await userEvent.click(screen.getByRole('button', { name: '前移 oldPlayer' }));
    await userEvent.click(screen.getByRole('button', { name: '提交路径' }));
    expect(socket.emit).toHaveBeenCalledWith('cslink:submit', expect.objectContaining({ roomId: 'L12345', roundId: 'round-1', dataVersion: 'v1',
      routeIds: [start.id, niko.id, legacy.id, lower.id, end.id], eventId: expect.any(String) }), expect.any(Function));
  });

  it('keeps a submitted best while allowing edits and refuses an invalid route without inventing a score', async () => {
    currentRoom = { ...playingRoom(), myBest: finish() };
    currentRoom.players[0].best = { jumps: 2, elapsedMs: 8_000 };
    const original = socket.emit.getMockImplementation()!;
    socket.emit.mockImplementation((event, body, ack) => {
      if (event === 'cslink:submit') ack({ ...envelope(), code: 'INVALID_PATH', reason: 'unverified_jump' });
      else original(event, body, ack);
    });
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: '清空中间选手' }));
    await userEvent.click(screen.getByRole('button', { name: '提交路径' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('至少一段在当前关系库中没有同队比赛记录');
    expect(screen.getByText('已保存最佳成绩')).toHaveTextContent('2 跳 · 8.00 秒');
    expect(screen.getByRole('button', { name: '提交路径' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '恢复最佳路径' }));
    expect(within(screen.getByRole('list', { name: '当前路径' })).getByText('NiKo')).toBeInTheDocument();
  });

  it('does not roll a finished round back when an old submit acknowledgement arrives late', async () => {
    currentRoom = playingRoom();
    let submitAck: ((reply: DuelResponse) => void) | undefined;
    const original = socket.emit.getMockImplementation()!;
    socket.emit.mockImplementation((event, body, ack) => {
      if (event === 'cslink:submit') submitAck = ack;
      else original(event, body, ack);
    });
    renderRoom();
    await userEvent.click(await screen.findByRole('button', { name: '提交路径' }));
    const old = structuredClone(currentRoom);
    const completed: DuelRoom = { ...currentRoom, status: 'finished', revision: 10, myBest: finish(),
      result: { winnerKeys: ['me'], reason: 'one_completed', rankings: [{ key: 'me', name: 'Alice', rank: 1, best: finish(), left: false },
        { key: 'friend', name: 'Bob', rank: null, best: null, left: false }] } };
    push(completed);
    act(() => submitAck?.({ ...envelope(old), improved: true }));
    expect(await screen.findByRole('region', { name: '本局结果' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '编辑你的路径' })).not.toBeInTheDocument();
    expect(screen.queryByText(/连通成功，最佳成绩已更新/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '第 1 跳 HLTV 地图 #13311' })).toHaveAttribute('href', finish().hops[0].evidence.sourceUrl);
    expect(screen.getByRole('heading', { name: 'Alice 获胜' })).toBeInTheDocument();
  });

  it('disables submissions while offline, restores server state on reconnect, and rematches through the lobby', async () => {
    currentRoom = { ...playingRoom(), myBest: finish() };
    const original = socket.emit.getMockImplementation()!;
    socket.emit.mockImplementation((event, body, ack) => {
      if (event === 'cslink:rematch') { currentRoom = { ...createRoom(), revision: 12 }; ack(envelope()); }
      else original(event, body, ack);
    });
    renderRoom();
    await screen.findByRole('button', { name: '提交路径' });
    socket.connected = false;
    act(() => socket.handlers.get('disconnect')?.());
    expect(screen.getByRole('button', { name: '提交路径' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('连接已断开');
    currentRoom = { ...currentRoom, revision: 11, status: 'finished', result: { winnerKeys: [], reason: 'all_incomplete',
      rankings: [{ key: 'me', name: 'Alice', rank: null, best: null, left: false }] } };
    socket.connected = true;
    act(() => socket.handlers.get('connect')?.());
    expect(await screen.findByRole('heading', { name: '本局平局 · 所有人未完成' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '再来一局' }));
    expect(await screen.findByRole('region', { name: '房间准备' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '本局结果' })).not.toBeInTheDocument();
  });

  it('only interprets the expected share-link path as a room identifier', () => {
    expect(parseDuelRoomInput(' L12345 ')).toBe('L12345');
    expect(parseDuelRoomInput('http://localhost:5173/teammates/duel/L12345?invite=1')).toBe('L12345');
    expect(parseDuelRoomInput('https://example.com/unrelated')).toBe('');
  });

  it('shows a rejected connection reason and allows an explicit retry while disconnected', async () => {
    socket.connected = false;
    renderRoom('/teammates/duel');
    act(() => socket.handlers.get('connect_error')?.({ message: 'TOO_MANY_CONNECTIONS' }));
    expect(screen.getByRole('alert')).toHaveTextContent('当前身份或网络连接数过多');
    expect(screen.getByRole('alert')).toHaveTextContent('TOO_MANY_CONNECTIONS');
    expect(screen.getByRole('button', { name: '重新连接' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '重新连接' }));
    socket.connected = true;
    act(() => socket.handlers.get('connect')?.());
    await waitFor(() => expect(screen.getByRole('button', { name: '创建连通房间' })).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
