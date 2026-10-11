import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { StoredIdentity } from '../services/roomStore';
import { CsLinkRooms, CsLinkRoomOptions, CsLinkRoomStore, CsLinkRoomReply } from '../services/cslinkRooms';
import { allowLocalGuess, socketAllowedWithIp } from './connection';
import { registerSocketEvent } from './event';

const roomId = z.string().regex(/^L[0-9A-F]{5}$/);
const roomPayload = z.object({ roomId }).strict();
const emptyPayload = z.object({}).strict();
const submitPayload = roomPayload.extend({ roundId: z.string().uuid(), dataVersion: z.string().min(1).max(80),
  eventId: z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/),
  routeIds: z.array(z.string().min(1).max(80)).min(2).max(17) }).strict();

/** Attaches to the existing authenticated default namespace; separate from the guessing game's rooms. */
export function setupCsLinkRooms(io: Server, store: CsLinkRoomStore, options: CsLinkRoomOptions = {}): () => void {
  const sockets = new Map<string, Set<Socket>>();
  const attached = new Map<Socket, () => void>();
  const rooms = new CsLinkRooms(store, keys => {
    for (const key of keys) {
      const reply = rooms.sync(key);
      for (const socket of sockets.get(key) ?? []) socket.emit('cslink:state', reply);
    }
  }, options);
  const now = options.now ?? Date.now;
  const onConnection = (socket: Socket) => {
    const identity = socket.data.identity as StoredIdentity | undefined;
    if (!identity?.key) return;
    let identitySockets = sockets.get(identity.key);
    if (!identitySockets) { identitySockets = new Set(); sockets.set(identity.key, identitySockets); }
    identitySockets.add(socket);
    rooms.connect(identity, socket.id);
    const register = (event: string, schema: z.ZodTypeAny,
      action: (payload: any, receivedAt: number) => CsLinkRoomReply) => {
      registerSocketEvent(socket, `cslink:${event}`, async (payload, ack) => {
        const receivedAt = now();
        if (socket.data.identity?.key !== identity.key) return ack?.({ code: 'IDENTITY_REQUIRED' });
        // Submit is synchronous after receipt: Redis latency cannot move it past the fixed deadline.
        const allowed = event === 'submit'
          ? allowLocalGuess(`cslink:${identity.key}`)
          : await socketAllowedWithIp(socket, `cslink:${event}`, identity.key, event === 'create' ? 10 : 90, 300, 60);
        if (!allowed) return ack?.({ code: 'RATE_LIMITED' });
        ack?.(action(payload, receivedAt));
      }, schema);
    };
    register('create', z.object({ durationSeconds: z.number().int().min(20).max(600).optional(),
      maxPlayers: z.number().int().min(2).max(8).optional() }).strict(),
    payload => rooms.create(identity, payload.durationSeconds, payload.maxPlayers));
    register('join', roomPayload, payload => rooms.join(identity, payload.roomId));
    register('sync', emptyPayload, () => rooms.sync(identity.key));
    register('ready', roomPayload.extend({ ready: z.boolean() }).strict(), payload => rooms.ready(identity.key, payload.roomId, payload.ready));
    register('start', roomPayload, payload => rooms.start(identity.key, payload.roomId));
    register('submit', submitPayload, (payload, at) => rooms.submit(identity.key, payload, at));
    register('rematch', roomPayload, payload => rooms.rematch(identity.key, payload.roomId));
    register('leave', roomPayload, payload => rooms.leave(identity.key, payload.roomId));
    const onDisconnect = () => {
      attached.delete(socket); identitySockets!.delete(socket);
      if (!identitySockets!.size) sockets.delete(identity.key);
      rooms.disconnect(identity.key, socket.id);
    };
    attached.set(socket, onDisconnect);
    socket.on('disconnect', onDisconnect);
    socket.emit('cslink:state', rooms.sync(identity.key));
  };
  io.on('connection', onConnection);
  return () => {
    io.off('connection', onConnection);
    for (const [socket, onDisconnect] of attached) {
      socket.off('disconnect', onDisconnect);
      for (const event of ['create', 'join', 'sync', 'ready', 'start', 'submit', 'rematch', 'leave']) {
        socket.removeAllListeners(`cslink:${event}`);
      }
    }
    rooms.stop(); sockets.clear(); attached.clear();
  };
}
