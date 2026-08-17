import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  collectorToServerSchema,
  webToServerSchema,
  type ServerToCollector,
  type ServerToWeb,
} from '@sloppers/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from './db.js';
import type { Room, WebClient } from './room.js';
import type { RoomManager } from './rooms.js';

const MAX_PAYLOAD = 256 * 1024;

/**
 * Wires both WebSocket endpoints onto the HTTP server:
 *
 * - `/ws/web`      browsers; first message must be `join`
 * - `/ws/collector` daemons; first message must be `hello` with a device key
 */
export interface WebSocketsHandle {
  /** Terminate every client and let their close handlers drain. */
  close(): Promise<void>;
}

export function attachWebSockets(
  server: Server,
  deps: { db: Db; rooms: RoomManager },
): WebSocketsHandle {
  const webWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const collectorWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://internal').pathname;
    if (path === '/ws/web') {
      webWss.handleUpgrade(req, socket, head, (ws) => handleWeb(ws, deps));
    } else if (path === '/ws/collector') {
      collectorWss.handleUpgrade(req, socket, head, (ws) => handleCollector(ws, deps));
    } else {
      socket.destroy();
    }
  });

  return {
    async close() {
      for (const wss of [webWss, collectorWss]) {
        for (const client of wss.clients) client.terminate();
        wss.close();
      }
      // Close handlers (which touch rooms and the db) run on later ticks.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function sendWeb(ws: WebSocket, message: ServerToWeb): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendCollector(ws: WebSocket, message: ServerToCollector): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function handleWeb(ws: WebSocket, deps: { rooms: RoomManager }): void {
  let room: Room | null = null;
  let client: WebClient | null = null;

  ws.on('message', (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return sendWeb(ws, { type: 'error', code: 'bad-message', message: 'not json' });
    }
    const parsed = webToServerSchema.safeParse(raw);
    if (!parsed.success) {
      return sendWeb(ws, { type: 'error', code: 'bad-message', message: 'unrecognized message' });
    }
    const msg = parsed.data;

    if (msg.type === 'join') {
      if (client) return; // already joined
      const { rooms } = deps;

      if (msg.memberId && msg.memberSecret) {
        // Resume an existing identity; its room wins over the URL's.
        const member = rooms.authMember(msg.memberId, msg.memberSecret);
        if (!member) {
          return sendWeb(ws, { type: 'error', code: 'bad-join', message: 'unknown member' });
        }
        room = rooms.getOrCreate(member.roomCode);
        room.memberJoined(member);
        client = { ws, memberId: member.id, present: true };
        const world = room.addWebClient(client);
        if (world) sendWeb(ws, world);
        return;
      }

      if (!msg.displayName) {
        return sendWeb(ws, { type: 'error', code: 'bad-join', message: 'displayName required' });
      }
      room = rooms.getOrCreate(msg.roomCode);
      const created = rooms.createMember(msg.roomCode, msg.displayName, msg.avatar);
      if (created === 'name-taken') {
        room = null;
        return sendWeb(ws, {
          type: 'error',
          code: 'name-taken',
          message: `someone here is already called ${msg.displayName}`,
        });
      }
      room.memberJoined(created);
      client = { ws, memberId: created.id, present: true };
      const world = room.addWebClient(client);
      if (world) sendWeb(ws, { ...world, you: { ...world.you, memberSecret: created.secret } });
      return;
    }

    if (!room || !client) return;
    if (msg.type === 'move') {
      room.updatePosition(client.memberId, msg.position);
    } else if (msg.type === 'activity') {
      room.setWebPresent(client, msg.present);
    }
  });

  ws.on('close', () => {
    if (room && client) room.removeWebClient(client);
  });
}

function handleCollector(ws: WebSocket, deps: { db: Db; rooms: RoomManager }): void {
  let room: Room | null = null;
  let memberId: string | null = null;

  ws.on('message', (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(data));
    } catch {
      return sendCollector(ws, { type: 'error', code: 'bad-message', message: 'not json' });
    }
    const parsed = collectorToServerSchema.safeParse(raw);
    if (!parsed.success) {
      return sendCollector(ws, {
        type: 'error',
        code: 'bad-message',
        message: 'unrecognized message',
      });
    }
    const msg = parsed.data;

    if (msg.type === 'hello') {
      const row = deps.db
        .prepare('SELECT member_id FROM devices WHERE key = ?')
        .get(msg.deviceKey) as { member_id: string } | undefined;
      const member = row ? deps.rooms.memberById(row.member_id) : null;
      if (!member) {
        sendCollector(ws, {
          type: 'error',
          code: 'unknown-device',
          message: 'device not paired; run `sloppers share` again',
        });
        return ws.close();
      }
      room = deps.rooms.getOrCreate(member.roomCode);
      room.memberJoined(member);
      memberId = member.id;
      room.attachCollector(member.id, ws);
      sendCollector(ws, {
        type: 'hello-ok',
        memberId: member.id,
        displayName: member.displayName,
        roomCode: member.roomCode,
      });
      return;
    }

    if (msg.type === 'snapshot' && room && memberId) {
      room.ingestSnapshot(memberId, msg, Date.now());
    }
  });

  ws.on('close', () => {
    if (room && memberId) room.detachCollector(memberId, ws);
  });
}
