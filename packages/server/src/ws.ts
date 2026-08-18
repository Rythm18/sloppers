import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  collectorToServerSchema,
  type ServerToCollector,
  type ServerToWeb,
  webToServerSchema,
} from '@sloppers/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import type { Db } from './db.js';
import type { Room, WebClient } from './room.js';
import type { RoomManager } from './rooms.js';

const MAX_PAYLOAD = 256 * 1024;
const HEARTBEAT_MS = 30_000;
/** Join attempts allowed per IP per minute — generous for humans and
 * reconnect storms, hostile to member-minting scripts. */
const JOINS_PER_MINUTE = 30;

/**
 * Wires both WebSocket endpoints onto the HTTP server:
 *
 * - `/ws/web`      browsers; first message must be `join`
 * - `/ws/collector` daemons; first message must be `hello` with a device key
 *
 * Both endpoints run a standard ping/pong heartbeat: a peer that misses a
 * round gets terminated, so half-open sockets (sleeping laptops, dropped
 * networks) can't hold presence 'active' or buffer broadcasts forever.
 */
export interface WebSocketsHandle {
  /** Terminate every client and let their close handlers drain. */
  close(): Promise<void>;
}

interface AliveSocket extends WebSocket {
  isAlive?: boolean;
}

function startHeartbeat(wss: WebSocketServer): NodeJS.Timeout {
  wss.on('connection', (ws: AliveSocket) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });
  return setInterval(() => {
    for (const client of wss.clients as Set<AliveSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, HEARTBEAT_MS);
}

/** Sliding one-minute window of join attempts per IP. */
class JoinLimiter {
  private attempts = new Map<string, number[]>();

  allow(ip: string, now: number = Date.now()): boolean {
    const windowStart = now - 60_000;
    const list = (this.attempts.get(ip) ?? []).filter((t) => t > windowStart);
    if (list.length >= JOINS_PER_MINUTE) {
      this.attempts.set(ip, list);
      return false;
    }
    list.push(now);
    this.attempts.set(ip, list);
    if (this.attempts.size > 10_000) this.attempts.clear();
    return true;
  }
}

/**
 * X-Forwarded-For is client-controlled unless a trusted proxy sets it —
 * honoring it on a direct deployment lets one machine mint unlimited
 * "IPs" past the rate limiter. Opt in with TRUST_PROXY=1 when running
 * behind a reverse proxy that overwrites the header.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Concurrent-socket budget: per-IP and global, across both endpoints. */
const MAX_SOCKETS_PER_IP = 32;
const MAX_SOCKETS_TOTAL = 2000;

class ConnectionBudget {
  private perIp = new Map<string, number>();
  private total = 0;

  tryAcquire(ip: string): boolean {
    const mine = this.perIp.get(ip) ?? 0;
    if (this.total >= MAX_SOCKETS_TOTAL || mine >= MAX_SOCKETS_PER_IP) return false;
    this.perIp.set(ip, mine + 1);
    this.total += 1;
    return true;
  }

  release(ip: string): void {
    const mine = this.perIp.get(ip) ?? 0;
    if (mine <= 1) this.perIp.delete(ip);
    else this.perIp.set(ip, mine - 1);
    this.total = Math.max(0, this.total - 1);
  }
}

/** Browsers send Origin; when present it must match the host we serve. */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attachWebSockets(
  server: Server,
  deps: { db: Db; rooms: RoomManager },
): WebSocketsHandle {
  const webWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const collectorWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const limiter = new JoinLimiter();
  const budget = new ConnectionBudget();
  const heartbeats = [startHeartbeat(webWss), startHeartbeat(collectorWss)];

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://internal').pathname;
    if (path !== '/ws/web' && path !== '/ws/collector') return socket.destroy();
    const ip = clientIp(req);
    if (!budget.tryAcquire(ip)) return socket.destroy();

    if (path === '/ws/web') {
      if (!originAllowed(req)) {
        budget.release(ip);
        return socket.destroy();
      }
      webWss.handleUpgrade(req, socket, head, (ws) => {
        webWss.emit('connection', ws, req);
        ws.on('close', () => budget.release(ip));
        handleWeb(ws, ip, { rooms: deps.rooms, limiter });
      });
    } else {
      collectorWss.handleUpgrade(req, socket, head, (ws) => {
        collectorWss.emit('connection', ws, req);
        ws.on('close', () => budget.release(ip));
        handleCollector(ws, deps);
      });
    }
  });

  return {
    async close() {
      for (const timer of heartbeats) clearInterval(timer);
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

function handleWeb(
  ws: WebSocket,
  ip: string,
  deps: { rooms: RoomManager; limiter: JoinLimiter },
): void {
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
      if (!deps.limiter.allow(ip)) {
        sendWeb(ws, { type: 'error', code: 'bad-join', message: 'too many joins; slow down' });
        return ws.close();
      }
      const { rooms } = deps;

      if (msg.memberId && msg.memberSecret) {
        // Resume an existing identity; its member row knows its room.
        const member = rooms.authMember(msg.memberId, msg.memberSecret);
        if (!member) {
          return sendWeb(ws, { type: 'error', code: 'bad-join', message: 'unknown member' });
        }
        room = rooms.getRoom(member.roomCode);
        if (!room) {
          return sendWeb(ws, { type: 'error', code: 'server-error', message: 'room unavailable' });
        }
        rooms.touchMember(member.id);
        room.memberJoined(member);
        client = { ws, memberId: member.id, present: true };
        const world = room.addWebClient(client);
        if (world) sendWeb(ws, world);
        return;
      }

      if (!msg.displayName) {
        return sendWeb(ws, { type: 'error', code: 'bad-join', message: 'displayName required' });
      }

      if (msg.createRoom) {
        room = rooms.createRoom(msg.createRoom);
        if (!room) {
          return sendWeb(ws, {
            type: 'error',
            code: 'server-error',
            message: 'this server is not accepting new offices right now',
          });
        }
      } else if (msg.roomCode) {
        room = rooms.getRoom(msg.roomCode);
        if (!room) {
          return sendWeb(ws, {
            type: 'error',
            code: 'room-not-found',
            message: 'that invite does not point to an office — check the link',
          });
        }
      } else {
        return sendWeb(ws, {
          type: 'error',
          code: 'bad-join',
          message: 'an invite code or a new office name is required',
        });
      }

      const created = rooms.createMember(room.code, msg.displayName, msg.avatar);
      if (created === 'name-taken') {
        room = null;
        return sendWeb(ws, {
          type: 'error',
          code: 'name-taken',
          message: `someone here is already called ${msg.displayName}`,
        });
      }
      if (created === 'room-full') {
        room = null;
        return sendWeb(ws, { type: 'error', code: 'bad-join', message: 'this office is full' });
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
      if (memberId) return; // duplicate hello on the same socket
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
      room = deps.rooms.getRoom(member.roomCode);
      if (!room) {
        sendCollector(ws, { type: 'error', code: 'server-error', message: 'room unavailable' });
        return ws.close();
      }
      deps.rooms.touchMember(member.id);
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
      room.ingestSnapshot(memberId, ws, msg, Date.now());
    }
  });

  ws.on('close', () => {
    if (room && memberId) room.detachCollector(memberId, ws);
  });
}
