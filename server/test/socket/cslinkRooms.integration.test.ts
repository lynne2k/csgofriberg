import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo, Socket } from 'socket.io-client';
import { setupCsLinkRooms } from '../../src/socket/cslinkRooms';
import { roomFixture, shortRoute } from '../fixtures/cslinkRooms';

let server: http.Server, io: Server, stop: () => void, baseUrl: string, now: number;
let clients: Socket[] = [];
const emit = (socket: Socket, event: string, value: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
  socket.timeout(2000).emit(`cslink:${event}`, value, (err: unknown, response: unknown) => err ? reject(err) : resolve(response));
});
async function connect(key: string) {
  const socket = clientIo(baseUrl, { transports: ['websocket'], auth: { key }, forceNew: true });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}

describe('CS Link room socket transport', () => {
  beforeEach(async () => {
    now = 1_000_000; server = http.createServer(); io = new Server(server);
    // Authentication itself is covered by existing setupSocket tests. This verifies that handlers
    // use the middleware identity and never accept a player key in game payloads.
    io.use((socket, next) => {
      const key = socket.handshake.auth.key;
      if (!key) return next(new Error('IDENTITY_REQUIRED'));
      socket.data.identity = { key, name: key, userId: null }; socket.data.ip = '127.0.0.1'; next();
    });
    stop = setupCsLinkRooms(io, roomFixture(), { now: () => now });
    await new Promise<void>(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    stop(); for (const client of clients) client.disconnect(); clients = [];
    await new Promise<void>(resolve => io.close(() => resolve()));
  });

  it('runs two socket clients through private submissions, reconnection, deadline settlement and rematch', async () => {
    const a = await connect(`a-${Math.random()}`), bKey = `b-${Math.random()}`, b = await connect(bKey);
    let response = await emit(a, 'create', { durationSeconds: 60 }); const roomId = response.room.id;
    const aKey = response.meKey;
    expect(roomId).toMatch(/^L[0-9A-F]{5}$/);
    await emit(b, 'join', { roomId });
    await emit(a, 'ready', { roomId, ready: true }); await emit(b, 'ready', { roomId, ready: true });
    response = await emit(a, 'start', { roomId }); const round = response.room.round;
    const input = { roomId, roundId: round.roundId, dataVersion: round.dataVersion, routeIds: shortRoute, eventId: 'first-event' };
    now += 1000;
    expect((await emit(a, 'submit', input)).improved).toBe(true);
    now += 1000;
    response = await emit(b, 'sync');
    expect(response.room.myBest).toBeNull(); expect(response.room.result).toBeNull();
    expect(JSON.stringify(response.room)).not.toContain('routeIds');
    expect((await emit(b, 'submit', { ...input, eventId: 'second-event' })).room.myBest.elapsedMs).toBe(2000);
    b.disconnect(); const reconnected = await connect(bKey);
    expect((await emit(reconnected, 'sync')).room.myBest.elapsedMs).toBe(2000);
    expect((await emit(a, 'submit', input)).room.myBest.elapsedMs).toBe(1000);
    now = round.serverDeadlineAtMs + 1;
    response = await emit(reconnected, 'sync');
    expect(response.room.result).toMatchObject({ winnerKeys: [aKey], reason: 'faster_time' });
    expect(response.room.result.rankings[0].best.hops).toHaveLength(3);
    expect((await emit(a, 'rematch', { roomId })).room).toMatchObject({ status: 'lobby', round: null, myBest: null });
    expect((await emit(reconnected, 'leave', { roomId })).room).toBeNull();
  });

  it('validates payload sizes and ignores client identity or client completion-time claims', async () => {
    const a = await connect(`validator-${Math.random()}`);
    expect((await emit(a, 'create', { maxPlayers: 9 })).code).toBe('VALIDATION_FAILED');
    expect((await emit(a, 'create', { playerKey: 'other' })).code).toBe('VALIDATION_FAILED');
    const roomId = (await emit(a, 'create', {})).room.id;
    expect((await emit(a, 'submit', { roomId, roundId: 'b5ca6562-7f24-4d29-b329-324b12a4f85b',
      dataVersion: 'v', eventId: 'invalid-event', routeIds: new Array(18).fill('hltv:1') })).code).toBe('VALIDATION_FAILED');
    expect((await emit(a, 'ready', { roomId, ready: true, serverCompletedAtMs: 0 })).code).toBe('VALIDATION_FAILED');
  });
});
