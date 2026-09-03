import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import {
  pairMintRequestSchema,
  pairRedeemRequestSchema,
  relinkMintRequestSchema,
  relinkRedeemRequestSchema,
} from '@sloppers/protocol';
import { type Context, Hono } from 'hono';
import type { Db } from './db/index.js';
import { deviceKey, pairingCode, relinkToken } from './ids.js';
import { isSafeHost, isSafeProto, trustsProxy } from './proxy.js';
import type { WorkspaceManager } from './workspace/manager.js';

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

/**
 * Where this request thinks it arrived, or `null` when nothing trustworthy
 * says.
 *
 * Fly terminates TLS at its proxy, so the socket here only ever sees plain
 * http and the forwarded headers are the only place the real scheme and host
 * survive. They are also the only headers a client can write freely, and this
 * value is interpolated into a document — so they are read only under
 * `TRUST_PROXY=1` (the same gate the rate limiter puts on `x-forwarded-for`,
 * ws.ts), and only when they are shaped like a scheme and a host. Anything
 * else falls through to what Node parsed for us, and if even that is not
 * presentable, to nothing at all.
 *
 * One consequence worth knowing about before it looks like a bug: a proxy
 * that terminates TLS but does not send `x-forwarded-proto` — or a deployment
 * that has not set `TRUST_PROXY=1` — makes this `http://`, so the unfurl card
 * is advertised over http. Set `TRUST_PROXY=1` behind a proxy that overwrites
 * the forwarded headers, which is the same thing that keeps everybody off one
 * rate-limit bucket.
 */
function originOf(c: Context): string | null {
  const url = new URL(c.req.url);
  const trusted = trustsProxy();
  const protos = [
    trusted ? c.req.header('x-forwarded-proto') : undefined,
    url.protocol.replace(':', ''),
  ];
  const hosts = [
    trusted ? c.req.header('x-forwarded-host') : undefined,
    c.req.header('host'),
    url.host,
  ];
  const proto = protos.find(isSafeProto);
  const host = hosts.find(isSafeHost);
  return proto && host ? `${proto}://${host}` : null;
}

/**
 * Rewrite the root-relative `og:image` / `twitter:image` in index.html to
 * absolute URLs against the host that asked for the page.
 *
 * Unfurlers want absolute URLs — Twitter's documentation insists on them —
 * but the file on disk cannot know what host it will be served from, and
 * hard-coding ours would mean every self-hosted office advertising a picture
 * of somebody else's. So the file keeps a path, and this fills in the origin
 * per request, which is the only place it is actually known.
 *
 * Deliberately narrow: only `content="/…"` on those two meta tags, only
 * index.html, only when it is about to be sent as an HTML document. Anything
 * broader would be a template engine, which this is not.
 */
export function absoluteSocialUrls(html: string, origin: string | null): string {
  // No trustworthy origin — leave the paths relative. Some unfurlers will
  // drop the card, but a missing picture beats reflecting a header we could
  // not vouch for into every page.
  if (!origin) return html;
  return html.replace(
    /(<meta\s+(?:property="og:image"|name="twitter:image")\s+content=")(\/[^"]*)"/g,
    (_match, head: string, path: string) => `${head}${origin}${path}"`,
  );
}

export function createApp(deps: { db: Db; rooms: WorkspaceManager; webDist?: string }): Hono {
  const { db, rooms } = deps;
  const app = new Hono();

  /** The invite code a member's workspace answers to right now. */
  const inviteCodeFor = (workspaceId: string): string | null =>
    rooms.roomById(workspaceId)?.code ?? null;

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
    const roomCode = inviteCodeFor(member.workspaceId);
    if (!roomCode) return c.json({ error: 'unknown member' }, 404);

    const key = deviceKey();
    db.prepare('INSERT INTO devices (key, member_id, created_at) VALUES (?, ?, ?)').run(
      key,
      member.id,
      Date.now(),
    );

    // The address the collector will dial back on. `originOf` can decline to
    // answer, and a pairing that succeeded but handed back no server would be
    // a worse failure than a guess — so the last resort is the URL Node
    // parsed, which is what this line used before there was anything to
    // validate.
    const origin = originOf(c) ?? new URL(c.req.url).origin;
    return c.json({
      deviceKey: key,
      memberId: member.id,
      displayName: member.displayName,
      roomCode,
      wsUrl: origin.replace(/^http/, 'ws'),
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
      .prepare("SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND status = 'active'")
      .get(room.id) as { n: number };
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
    const roomCode = inviteCodeFor(member.workspaceId);
    if (!roomCode) return c.json({ error: 'unknown device' }, 403);

    db.prepare('DELETE FROM relink_tokens WHERE expires_at < ?').run(Date.now());
    const token = relinkToken();
    const expiresAt = Date.now() + RELINK_TTL_MS;
    db.prepare('INSERT INTO relink_tokens (token, member_id, expires_at) VALUES (?, ?, ?)').run(
      token,
      member.id,
      expiresAt,
    );
    return c.json({ token, roomCode, expiresAt });
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
    const roomCode = inviteCodeFor(member.workspaceId);
    if (!roomCode) return c.json({ error: 'unknown member' }, 404);
    rooms.touchMember(member.id);
    return c.json({
      memberId: member.id,
      memberSecret: member.secret,
      roomCode,
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
      const headers = {
        'content-type': type,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      // The one document whose contents depend on who asked for it: the
      // unfurl card's URL has to be absolute, and only the request knows
      // against what. Everything else is bytes off the disk.
      if (type === MIME['.html']) {
        return c.body(
          absoluteSocialUrls(readFileSync(filePath, 'utf8'), originOf(c)),
          200,
          headers,
        );
      }
      return c.body(readFileSync(filePath), 200, headers);
    });
  }

  return app;
}
