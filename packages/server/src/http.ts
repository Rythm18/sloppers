import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import {
  pairMintRequestSchema,
  pairRedeemRequestSchema,
  relinkMintRequestSchema,
  relinkRedeemRequestSchema,
} from '@sloppers/protocol';
import { Hono } from 'hono';
import type { Db } from './db/index.js';
import { deviceKey, pairingCode, relinkToken } from './ids.js';
import type { RoomManager } from './rooms.js';

const PAIRING_TTL_MS = 10 * 60 * 1000;
const RELINK_TTL_MS = 10 * 60 * 1000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export function createApp(deps: { db: Db; rooms: RoomManager; webDist?: string }): Hono {
  const { db, rooms } = deps;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  /**
   * Mint a pairing code for a member (called by the office web app). The
   * member proves ownership with its secret; the code is what the human
   * pastes into `sloppers share`.
   */
  app.post('/api/pair', async (c) => {
    const body = pairMintRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad request' }, 400);
    const member = rooms.authMember(body.data.memberId, body.data.memberSecret);
    if (!member) return c.json({ error: 'unknown member' }, 403);

    db.prepare('DELETE FROM pairings WHERE expires_at < ?').run(Date.now());
    const code = pairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    db.prepare('INSERT INTO pairings (code, member_id, expires_at) VALUES (?, ?, ?)').run(
      code,
      member.id,
      expiresAt,
    );
    return c.json({ pairingCode: code, expiresAt });
  });

  /** One-shot redemption by the collector: pairing code → device key. */
  app.post('/api/pair/redeem', async (c) => {
    const body = pairRedeemRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad request' }, 400);
    const code = body.data.pairingCode.toUpperCase();
    const row = db.prepare('SELECT member_id, expires_at FROM pairings WHERE code = ?').get(code) as
      | { member_id: string; expires_at: number }
      | undefined;
    if (!row) return c.json({ error: 'unknown code' }, 404);
    db.prepare('DELETE FROM pairings WHERE code = ?').run(code);
    if (row.expires_at < Date.now()) return c.json({ error: 'expired code' }, 410);
    const member = rooms.memberById(row.member_id);
    if (!member) return c.json({ error: 'unknown member' }, 404);

    const key = deviceKey();
    db.prepare('INSERT INTO devices (key, member_id, created_at) VALUES (?, ?, ?)').run(
      key,
      member.id,
      Date.now(),
    );

    const url = new URL(c.req.url);
    const proto = c.req.header('x-forwarded-proto') ?? url.protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? url.host;
    return c.json({
      deviceKey: key,
      memberId: member.id,
      displayName: member.displayName,
      roomCode: member.roomCode,
      wsUrl: `${proto === 'https' ? 'wss' : 'ws'}://${host}`,
    });
  });

  /**
   * Invite preview: lets the join screen greet an invitee with the office
   * name and who's inside before they commit to a name. The code is already
   * the capability, so revealing name + headcount to holders of it is fine.
   */
  app.get('/api/rooms/:code', (c) => {
    const room = rooms.getRoom(c.req.param('code'));
    if (!room) return c.json({ error: 'not found' }, 404);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM members WHERE room_code = ?')
      .get(room.code) as { n: number };
    return c.json({ name: room.name, memberCount: count.n });
  });

  /**
   * Relink: a paired collector proves it belongs to a member (device key)
   * and mints a one-shot token; opening the office URL that carries it
   * makes a fresh browser become that member. Recovery and second devices,
   * no login system.
   */
  app.post('/api/relink', async (c) => {
    const body = relinkMintRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad request' }, 400);
    const row = db
      .prepare('SELECT member_id FROM devices WHERE key = ?')
      .get(body.data.deviceKey) as { member_id: string } | undefined;
    const member = row ? rooms.memberById(row.member_id) : null;
    if (!member) return c.json({ error: 'unknown device' }, 403);

    db.prepare('DELETE FROM relink_tokens WHERE expires_at < ?').run(Date.now());
    const token = relinkToken();
    const expiresAt = Date.now() + RELINK_TTL_MS;
    db.prepare('INSERT INTO relink_tokens (token, member_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      member.id,
      expiresAt,
    );
    return c.json({ token, roomCode: member.roomCode, expiresAt });
  });

  app.post('/api/relink/redeem', async (c) => {
    const body = relinkRedeemRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad request' }, 400);
    const row = db
      .prepare('SELECT member_id, expires_at FROM relink_tokens WHERE token = ?')
      .get(body.data.token) as { member_id: string; expires_at: number } | undefined;
    if (!row) return c.json({ error: 'unknown token' }, 404);
    db.prepare('DELETE FROM relink_tokens WHERE token = ?').run(body.data.token);
    if (row.expires_at < Date.now()) return c.json({ error: 'expired token' }, 410);
    const member = rooms.memberById(row.member_id);
    if (!member) return c.json({ error: 'unknown member' }, 404);
    rooms.touchMember(member.id);
    return c.json({
      memberId: member.id,
      memberSecret: member.secret,
      roomCode: member.roomCode,
      displayName: member.displayName,
    });
  });

  // The built web app, when present, with SPA fallback. Hand-rolled so it
  // works from any cwd and needs no extra dependency.
  const webDist = deps.webDist;
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    app.get('*', (c) => {
      const requested = normalize(new URL(c.req.url).pathname).replace(/^(\.\.[/\\])+/, '');
      let filePath = join(webDist, requested);
      if (
        !filePath.startsWith(webDist) ||
        !existsSync(filePath) ||
        statSync(filePath).isDirectory()
      ) {
        filePath = join(webDist, 'index.html');
      }
      const type = MIME[extname(filePath)] ?? 'application/octet-stream';
      const immutable = requested.startsWith('/assets/');
      return c.body(readFileSync(filePath), 200, {
        'content-type': type,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
    });
  }

  return app;
}
