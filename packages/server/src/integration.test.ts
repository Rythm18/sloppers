import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import {
  type ChatMessage,
  dayIn,
  dayOf,
  type KnockView,
  MAX_CHAT_LENGTH,
  normalizeChatText,
  type PairRedeemResponse,
  recentDays,
  type ServerToWeb,
  serverToWebSchema,
  type WebChatLog,
  type WebWorld,
} from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createSloppersServer, type SloppersServer } from './index.js';

/**
 * The whole loop against a real server on an ephemeral port: browser joins,
 * mints a pairing code, a collector redeems it and streams a snapshot, and
 * the browser sees presence and leaderboard update.
 */

class WebClientHarness {
  private ws: WebSocket;
  private queue: ServerToWeb[] = [];
  private waiters: ((msg: ServerToWeb) => void)[] = [];

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws/web`);
    this.ws.on('message', (data) => {
      const msg = serverToWebSchema.parse(JSON.parse(String(data)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(msg: object): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Next message, optionally skipping until a predicate matches. */
  async next(match?: (msg: ServerToWeb) => boolean, timeoutMs = 5000): Promise<ServerToWeb> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const msg =
        this.queue.shift() ??
        (await new Promise<ServerToWeb>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('timed out waiting for message')),
            Math.max(1, deadline - Date.now()),
          );
          this.waiters.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        }));
      if (!match || match(msg)) return msg;
    }
  }

  close(): void {
    this.ws.close();
  }

  /** Resolves once the server hangs up on this socket. */
  async waitClosed(timeoutMs = 5000): Promise<void> {
    if (this.ws.readyState === this.ws.CLOSED) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket never closed')), timeoutMs);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

describe('server integration', () => {
  let server: SloppersServer;
  const clients: WebClientHarness[] = [];

  beforeEach(async () => {
    officeCode = null;
    server = await createSloppersServer({ port: 0, hostname: '127.0.0.1', dbPath: ':memory:' });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
  });

  /** First member creates the office; the rest follow the minted code. */
  let officeCode: string | null = null;

  async function join(name: string): Promise<{ client: WebClientHarness; world: WebWorld }> {
    const client = new WebClientHarness(server.port);
    clients.push(client);
    await client.open();
    client.send(
      officeCode
        ? { type: 'join', roomCode: officeCode, displayName: name }
        : // The office is created the way a browser creates one, this machine's
          // zone included — so the day the board serves is the day `dayOf` cuts
          // here, and the assertions below can name one date for both.
          {
            type: 'join',
            createRoom: 'the lab',
            displayName: name,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
    );
    const world = (await client.next((m) => m.type === 'world')) as WebWorld;
    // Entering also carries the office's own state; swallow it here so a test
    // waiting on a `workspace` message is waiting for the change it made.
    await client.next((m) => m.type === 'workspace');
    officeCode = world.roomCode;
    return { client, world };
  }

  it('create office → capability code; second member joins by code', async () => {
    const { client: a, world } = await join('ridham');
    expect(world.roomCode).toMatch(/^the-lab-[a-z0-9]{6}$/);
    expect(world.roomName).toBe('the lab');
    expect(world.you.memberSecret).toBeTruthy();
    expect(world.members).toHaveLength(1);

    const { world: worldB } = await join('sam');
    expect(worldB.roomCode).toBe(world.roomCode);
    expect(worldB.members).toHaveLength(2);

    const upsert = await a.next((m) => m.type === 'member');
    expect(upsert.type === 'member' && upsert.member.displayName).toBe('sam');
  });

  it('guessed room codes bounce; invite preview works for real ones', async () => {
    const { world } = await join('ridham');

    const stranger = new WebClientHarness(server.port);
    clients.push(stranger);
    await stranger.open();
    stranger.send({ type: 'join', roomCode: 'the-lab', displayName: 'mallory' });
    const err = await stranger.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('room-not-found');

    const base = `http://127.0.0.1:${server.port}`;
    const preview = await fetch(`${base}/api/rooms/${world.roomCode}`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ name: 'the lab', memberCount: 1 });
    const dead = await fetch(`${base}/api/rooms/the-lab-zzzzzz`);
    expect(dead.status).toBe(404);
  });

  it('rejects duplicate names but allows resume with credentials', async () => {
    const { world } = await join('ridham');
    const dupe = new WebClientHarness(server.port);
    clients.push(dupe);
    await dupe.open();
    dupe.send({ type: 'join', roomCode: world.roomCode, displayName: 'RIDHAM' });
    const err = await dupe.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('name-taken');

    const resumed = new WebClientHarness(server.port);
    clients.push(resumed);
    await resumed.open();
    resumed.send({
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    const worldAgain = (await resumed.next((m) => m.type === 'world')) as WebWorld;
    expect(worldAgain.you.memberId).toBe(world.you.memberId);
  });

  it('relink: a paired device signs a fresh browser back in', async () => {
    const { world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    // Pair a device the normal way.
    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const { deviceKey } = (await redeem.json()) as { deviceKey: string };

    // The device mints a relink token; a "fresh browser" redeems it.
    const relink = await fetch(`${base}/api/relink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey }),
    });
    expect(relink.status).toBe(200);
    const minted = (await relink.json()) as { token: string; roomCode: string };
    expect(minted.roomCode).toBe(world.roomCode);

    const claim = await fetch(`${base}/api/relink/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: minted.token }),
    });
    expect(claim.status).toBe(200);
    const identity = (await claim.json()) as { memberId: string; memberSecret: string };
    expect(identity.memberId).toBe(world.you.memberId);

    // Tokens are one-shot.
    const again = await fetch(`${base}/api/relink/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: minted.token }),
    });
    expect(again.status).toBe(404);

    // The recovered identity actually resumes.
    const fresh = new WebClientHarness(server.port);
    clients.push(fresh);
    await fresh.open();
    fresh.send({
      type: 'join',
      memberId: identity.memberId,
      memberSecret: identity.memberSecret,
    });
    const back = (await fresh.next((m) => m.type === 'world')) as WebWorld;
    expect(back.you.memberId).toBe(world.you.memberId);

    // A bogus device key cannot mint.
    const bogus = await fetch(`${base}/api/relink`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceKey: 'f'.repeat(48) }),
    });
    expect(bogus.status).toBe(403);
  });

  /**
   * An office with a clock of its own, opened the way a browser opens one.
   * Its own client, because the shared `join` above funnels everybody into a
   * single office and these cases need two side by side.
   */
  async function openOfficeIn(name: string, timezone: string): Promise<WebClientHarness> {
    const client = new WebClientHarness(server.port);
    clients.push(client);
    await client.open();
    client.send({ type: 'join', createRoom: name, displayName: 'ridham', timezone });
    await client.next((m) => m.type === 'world');
    return client;
  }

  /**
   * Which day the office is in is the office's answer, and history is anchored
   * on it — so two offices looking at the same wall clock hand back two
   * different `days[0]`, each its own.
   *
   * Asserted against `dayIn` in each office's own zone rather than against a
   * hardcoded date, because this runs at whatever time of day it runs at.
   * There are five and a half hours every day when these two genuinely differ,
   * and the point is that each is right about itself in all twenty-four.
   */
  it('anchors history on the office’s own timezone', async () => {
    const kolkata = await openOfficeIn('the lab', 'Asia/Kolkata');
    const utc = await openOfficeIn('the annex', 'UTC');

    kolkata.send({ type: 'history', days: 2 });
    const theirs = await kolkata.next((m) => m.type === 'history');
    utc.send({ type: 'history', days: 2 });
    const ours = await utc.next((m) => m.type === 'history');
    if (theirs.type !== 'history' || ours.type !== 'history') throw new Error('unreachable');

    const now = Date.now();
    expect(theirs.days[0]).toBe(dayIn(now, 'Asia/Kolkata'));
    expect(ours.days[0]).toBe(dayIn(now, 'UTC'));
    // Whatever each anchor is, the day under it is the one before it.
    expect(theirs.days[1]).toBe(recentDays(dayIn(now, 'Asia/Kolkata'), 2)[1]);
  });

  /**
   * The owner's own choice, unlike the creator's browser hint, is refused
   * outright when it is not a zone — the message never reaches the ledger,
   * and the office's clock does not move.
   */
  it('refuses a settings op carrying a zone that is not one', async () => {
    const { client: owner } = await join('ridham');
    owner.send({
      type: 'admin',
      op: {
        kind: 'settings',
        settings: { joinMode: 'link', publicLeaderboard: false, timezone: 'Mars/Olympus' },
      },
    });
    const refusal = await owner.next((m) => m.type === 'error');
    expect(refusal.type === 'error' && refusal.code).toBe('bad-message');

    // ...and the real one lands, on the same wire, a moment later.
    owner.send({
      type: 'admin',
      op: {
        kind: 'settings',
        settings: { joinMode: 'link', publicLeaderboard: false, timezone: 'Asia/Kolkata' },
      },
    });
    const state = await owner.next((m) => m.type === 'workspace');
    expect(state.type === 'workspace' && state.settings.timezone).toBe('Asia/Kolkata');
  });

  it('movement relays to other members only', async () => {
    const { client: a } = await join('ridham');
    const { client: b, world: worldB } = await join('sam');
    void worldB;
    a.send({
      type: 'move',
      position: { x: 320, y: 240, dir: 'left', moving: true },
    });
    const pos = await b.next((m) => m.type === 'pos');
    expect(pos.type === 'pos' && pos.position.x).toBe(320);
  });

  it('tells an arriving browser how the office is set up', async () => {
    const { client: owner, world } = await join('ridham');
    owner.send({
      type: 'admin',
      op: { kind: 'settings', settings: { joinMode: 'link', publicLeaderboard: true } },
    });
    await owner.next((m) => m.type === 'workspace');

    // `world` carries no settings, and `workspace` is only pushed when
    // something changes — which in a settled office may be never. Without
    // this, a browser arriving later never learns how the door is set, and
    // its settings panel has nothing to show but defaults it would then
    // write back over the truth.
    const sam = await arrive(world.roomCode, 'sam');
    const state = await sam.next((m) => m.type === 'workspace');
    expect(state.type === 'workspace' && state.settings.publicLeaderboard).toBe(true);
  });

  it('pushes the roster to a watching moderator when somebody walks in', async () => {
    const { client: owner } = await join('ridham');

    // A browser's own arrival is broadcast before its socket is attached, so
    // nobody ever learns of a join from their own — and the roster is what
    // the settings panel moderates from. Unasked: no `roster` op is sent
    // here, the office volunteers it.
    await join('sam');

    const roster = await owner.next((m) => m.type === 'roster');
    if (roster.type !== 'roster') throw new Error('unreachable');
    expect(roster.members.map((m) => m.displayName)).toContain('sam');
  });

  it('keeps the roster to the people who moderate with it', async () => {
    await join('ridham');
    const { client: sam } = await join('sam');
    const { client: nina } = await join('nina');

    // sam is a plain member: the roster is the moderation view, and the
    // arrival that just pushed one to every admin must not reach them.
    // Nina's first step is the marker — it is broadcast strictly after
    // everything her arrival sent, so a leaked roster cannot hide behind it.
    nina.send({ type: 'move', position: { x: 7, y: 7, dir: 'up', moving: true } });
    const heard: string[] = [];
    let msg: ServerToWeb;
    do {
      msg = await sam.next();
      heard.push(msg.type);
    } while (msg.type !== 'pos');
    expect(heard).toContain('member');
    expect(heard).not.toContain('roster');
  });

  it('carries an admin op over the socket, and refuses one from a plain member', async () => {
    const { client: owner } = await join('ridham');
    const { client: sam, world: samWorld } = await join('sam');

    owner.send({ type: 'admin', op: { kind: 'rename', name: 'the annex' } });
    const renamed = await sam.next((m) => m.type === 'workspace');
    expect(renamed.type === 'workspace' && renamed.roomName).toBe('the annex');

    sam.send({ type: 'admin', op: { kind: 'rename', name: 'sams place' } });
    const refused = await sam.next((m) => m.type === 'error');
    expect(refused.type === 'error' && refused.code).toBe('forbidden');

    // Being removed is told, not just done: the browser needs to explain it.
    owner.send({ type: 'admin', op: { kind: 'kick', memberId: samWorld.you.memberId } });
    const removed = await sam.next((m) => m.type === 'removed');
    expect(removed.type === 'removed' && removed.reason).toBe('kicked');
  });

  it('answers a failing admin op instead of taking the whole server down', async () => {
    const { client: owner } = await join('ridham');
    const { client: sam } = await join('sam');

    // Pull the audit trail out from under the handler: the rename lands and
    // the logEvent behind it throws. An escaping throw here is an uncaught
    // exception, which would be every office on this process, not one socket.
    server.db.exec('DROP TABLE workspace_events');
    owner.send({ type: 'admin', op: { kind: 'rename', name: 'the annex' } });
    const err = await owner.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('server-error');

    // That socket still works, and so does everyone else's.
    owner.send({ type: 'admin', op: { kind: 'roster' } });
    expect((await owner.next((m) => m.type === 'roster')).type).toBe('roster');
    sam.send({ type: 'move', position: { x: 100, y: 100, dir: 'up', moving: false } });
    expect((await owner.next((m) => m.type === 'pos')).type).toBe('pos');
  });

  it('answers a failing join instead of taking the whole server down', async () => {
    const { client: owner, world } = await join('ridham');

    // Every way in writes, and the two inserts catch only the collision each
    // of them expects. A resume writes through `touchMember`, which catches
    // nothing at all — so a database that will not take writes (busy, locked,
    // read-only) throws straight out of the message handler, which is an
    // uncaught exception in the process serving every office.
    server.db.pragma('query_only = true');
    const resumed = new WebClientHarness(server.port);
    clients.push(resumed);
    await resumed.open();
    const credentials = {
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    };
    resumed.send(credentials);
    const err = await resumed.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('server-error');

    // Refused, not admitted halfway: nothing was sent that would let this
    // browser believe it is in an office.
    expect(err.type === 'error' && err.message).toContain('letting you in');

    // The office is still standing, and the socket that was in it still moves.
    owner.send({ type: 'move', position: { x: 42, y: 42, dir: 'up', moving: false } });
    owner.send({ type: 'admin', op: { kind: 'roster' } });
    expect((await owner.next((m) => m.type === 'roster')).type).toBe('roster');

    // And the refused socket is not spent — the same credentials work the
    // moment the database will take a write again.
    server.db.pragma('query_only = false');
    resumed.send(credentials);
    const back = (await resumed.next((m) => m.type === 'world')) as WebWorld;
    expect(back.you.memberId).toBe(world.you.memberId);
  });

  /** Flip an owner's office into a given join mode and wait for it to land. */
  async function setJoinMode(
    owner: WebClientHarness,
    joinMode: 'link' | 'knock' | 'locked',
  ): Promise<void> {
    owner.send({
      type: 'admin',
      op: { kind: 'settings', settings: { joinMode, publicLeaderboard: false } },
    });
    await owner.next((m) => m.type === 'workspace');
  }

  /** A browser that turns up at the door of an office it was pointed at. */
  async function arrive(roomCode: string, displayName: string): Promise<WebClientHarness> {
    const visitor = new WebClientHarness(server.port);
    clients.push(visitor);
    await visitor.open();
    visitor.send({ type: 'join', roomCode, displayName });
    return visitor;
  }

  /** The person at the front of the queue, as it reaches someone who can answer. */
  async function firstKnock(moderator: WebClientHarness): Promise<KnockView> {
    const queue = await moderator.next((m) => m.type === 'knocks');
    if (queue.type !== 'knocks') throw new Error('unreachable');
    const first = queue.knocks[0];
    if (!first) throw new Error('the queue arrived empty');
    return first;
  }

  it('knock mode holds a joiner until a moderator admits them', async () => {
    const { client: owner, world } = await join('ridham');
    owner.send({
      type: 'admin',
      op: { kind: 'settings', settings: { joinMode: 'knock', publicLeaderboard: false } },
    });
    await owner.next((m) => m.type === 'workspace');

    const visitor = new WebClientHarness(server.port);
    clients.push(visitor);
    await visitor.open();
    visitor.send({ type: 'join', roomCode: world.roomCode, displayName: 'sam' });
    expect((await visitor.next((m) => m.type === 'knocking')).type).toBe('knocking');

    const knock = await firstKnock(owner);
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: knock.id } });
    const admitted = await visitor.next((m) => m.type === 'world');
    expect(admitted.type).toBe('world');
  });

  it('locked mode refuses new members but still resumes existing ones', async () => {
    const { client: owner, world } = await join('ridham');
    owner.send({
      type: 'admin',
      op: { kind: 'settings', settings: { joinMode: 'locked', publicLeaderboard: false } },
    });
    await owner.next((m) => m.type === 'workspace');

    const stranger = new WebClientHarness(server.port);
    clients.push(stranger);
    await stranger.open();
    stranger.send({ type: 'join', roomCode: world.roomCode, displayName: 'sam' });
    const err = await stranger.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('workspace-locked');

    // Locking the door must not lock in the people already inside: resume is
    // a different branch, and only the create branch consults joinMode.
    const resumed = new WebClientHarness(server.port);
    clients.push(resumed);
    await resumed.open();
    resumed.send({
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    const back = (await resumed.next((m) => m.type === 'world')) as WebWorld;
    expect(back.you.memberId).toBe(world.you.memberId);
  });

  it('a rotated invite kills the old link while members keep resuming', async () => {
    const { client: owner, world } = await join('ridham');
    owner.send({ type: 'admin', op: { kind: 'rotate-invite' } });
    const updated = await owner.next((m) => m.type === 'workspace');
    if (updated.type !== 'workspace') throw new Error('unreachable');
    expect(updated.roomCode).not.toBe(world.roomCode);

    const stale = new WebClientHarness(server.port);
    clients.push(stale);
    await stale.open();
    stale.send({ type: 'join', roomCode: world.roomCode, displayName: 'sam' });
    const err = await stale.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('room-not-found');

    // The rotation revoked a link, not an identity.
    const resumed = new WebClientHarness(server.port);
    clients.push(resumed);
    await resumed.open();
    resumed.send({
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    const back = (await resumed.next((m) => m.type === 'world')) as WebWorld;
    expect(back.roomCode).toBe(updated.roomCode);
  });

  it('an admitted knocker becomes an ordinary member: seen, mobile, and single', async () => {
    const { client: owner, world } = await join('ridham');
    await setJoinMode(owner, 'knock');
    const visitor = await arrive(world.roomCode, 'sam');
    await visitor.next((m) => m.type === 'knocking');

    // Waiting is not membership: nothing this socket sends is acted on until
    // somebody opens the door, so an op a member would be answered about
    // draws no answer at all.
    visitor.send({ type: 'move', position: { x: 10, y: 10, dir: 'up', moving: true } });
    visitor.send({ type: 'admin', op: { kind: 'roster' } });

    const knock = await firstKnock(owner);
    expect(knock.displayName).toBe('sam');
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: knock.id } });

    // Everything the server said between the knock and the world, in order.
    const whileWaiting: string[] = [];
    let admitted: ServerToWeb;
    do {
      admitted = await visitor.next();
      whileWaiting.push(admitted.type);
    } while (admitted.type !== 'world');
    expect(whileWaiting).not.toContain('roster');
    expect(whileWaiting).not.toContain('error');
    if (admitted.type !== 'world') throw new Error('unreachable');
    // Minted just now, so the secret has to travel with the world.
    expect(admitted.you.memberSecret).toBeTruthy();

    // They are a real member of the office now: they move, and it is seen.
    visitor.send({ type: 'move', position: { x: 300, y: 200, dir: 'left', moving: true } });
    const pos = await owner.next((m) => m.type === 'pos');
    expect(pos.type === 'pos' && pos.memberId).toBe(admitted.you.memberId);

    // And joining again on the same socket must not mint a second member.
    // The move behind it lands afterwards, so the assertion is not racing a
    // join the server has not looked at yet.
    visitor.send({ type: 'join', roomCode: world.roomCode, displayName: 'sam the second' });
    visitor.send({ type: 'move', position: { x: 301, y: 200, dir: 'left', moving: true } });
    const after = await owner.next((m) => m.type === 'pos');
    expect(after.type === 'pos' && after.position.x).toBe(301);
    const preview = await fetch(`http://127.0.0.1:${server.port}/api/rooms/${world.roomCode}`);
    expect(await preview.json()).toEqual({ name: 'the lab', memberCount: 2 });
  });

  it('keeps the door queue to the people who can answer it', async () => {
    const { client: owner, world } = await join('ridham');
    const { client: nina } = await join('nina');
    await setJoinMode(owner, 'knock');
    await nina.next((m) => m.type === 'workspace');

    const visitor = await arrive(world.roomCode, 'sam');
    await visitor.next((m) => m.type === 'knocking');
    const knock = await firstKnock(owner);
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: knock.id } });

    // A plain member has no business knowing who is at the door. Everything
    // nina heard between the knock and the new arrival, with no queue in it —
    // a queue push would have landed before the member it let in.
    const heard: string[] = [];
    let msg: ServerToWeb;
    do {
      msg = await nina.next();
      heard.push(msg.type);
    } while (msg.type !== 'member');
    expect(heard).not.toContain('knocks');
  });

  it('a knocker who gives up disappears from the queue', async () => {
    const { client: owner, world } = await join('ridham');
    await setJoinMode(owner, 'knock');
    const visitor = await arrive(world.roomCode, 'sam');
    await visitor.next((m) => m.type === 'knocking');

    const queued = await owner.next((m) => m.type === 'knocks');
    expect(queued.type === 'knocks' && queued.knocks).toHaveLength(1);

    visitor.close();
    const emptied = await owner.next((m) => m.type === 'knocks');
    expect(emptied.type === 'knocks' && emptied.knocks).toHaveLength(0);
  });

  it('closes a socket that floods while knocking, and clears its knock too', async () => {
    const { client: owner, world } = await join('ridham');
    await setJoinMode(owner, 'knock');
    const visitor = await arrive(world.roomCode, 'sam');
    await visitor.next((m) => m.type === 'knocking');

    const queued = await owner.next((m) => m.type === 'knocks');
    expect(queued.type === 'knocks' && queued.knocks).toHaveLength(1);

    // Nothing this socket sends is acted on while it waits at the door — but
    // the rate limiter still meters it, because that is exactly where an
    // unauthenticated flood would come from. `move`'s burst is 40; two
    // refusals close together (well within the ten-second abuse window)
    // trip the close.
    for (let i = 0; i < 42; i++) {
      visitor.send({ type: 'move', position: { x: i, y: 0, dir: 'up', moving: true } });
    }

    // The server hung up on it, server-initiated — not the tab closing its
    // own connection — and that close still has to drain the knock queue.
    await visitor.waitClosed();
    const emptied = await owner.next((m) => m.type === 'knocks');
    expect(emptied.type === 'knocks' && emptied.knocks).toHaveLength(0);
  });

  it('hands the standing queue to someone who can answer it as they arrive', async () => {
    const { client: owner, world } = await join('ridham');
    const { client: sam, world: samWorld } = await join('sam');
    const { client: nina, world: ninaWorld } = await join('nina');
    owner.send({ type: 'admin', op: { kind: 'promote', memberId: samWorld.you.memberId } });
    await owner.next((m) => m.type === 'roster');
    await setJoinMode(owner, 'knock');

    // Both step away before anyone turns up at the door.
    sam.close();
    nina.close();
    const visitor = await arrive(world.roomCode, 'theo');
    await visitor.next((m) => m.type === 'knocking');
    // The one push the queue will ever make: it does not change again, so
    // anyone arriving later has to be told some other way.
    const knock = await firstKnock(owner);
    expect(knock.displayName).toBe('theo');

    // Sam comes back to a door that was knocked on while he was gone. The
    // queue is only pushed when it changes, and it will not change again, so
    // arriving has to carry it or theo waits with nobody aware of him.
    const samAgain = new WebClientHarness(server.port);
    clients.push(samAgain);
    await samAgain.open();
    samAgain.send({
      type: 'join',
      memberId: samWorld.you.memberId,
      memberSecret: samWorld.you.memberSecret,
    });
    const standing = await samAgain.next((m) => m.type === 'knocks');
    expect(standing.type === 'knocks' && standing.knocks[0]?.displayName).toBe('theo');

    // Arriving is not a way around the permission check: nina is a plain
    // member, and everything she hears from her own world up to theo landing
    // in the office has no queue in it.
    const ninaAgain = new WebClientHarness(server.port);
    clients.push(ninaAgain);
    await ninaAgain.open();
    ninaAgain.send({
      type: 'join',
      memberId: ninaWorld.you.memberId,
      memberSecret: ninaWorld.you.memberSecret,
    });
    await ninaAgain.next((m) => m.type === 'world');
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: knock.id } });
    const heard: string[] = [];
    let msg: ServerToWeb;
    do {
      msg = await ninaAgain.next();
      heard.push(msg.type);
    } while (msg.type !== 'member');
    expect(heard).not.toContain('knocks');
  });

  it('tells a moderator arriving at an empty door that it is empty', async () => {
    const { client: owner, world } = await join('ridham');
    await setJoinMode(owner, 'knock');

    // An authoritative empty list, so a reloading tab replaces whatever it
    // remembered instead of keeping a queue from before.
    const reloaded = new WebClientHarness(server.port);
    clients.push(reloaded);
    await reloaded.open();
    reloaded.send({
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    const standing = await reloaded.next((m) => m.type === 'knocks');
    expect(standing.type === 'knocks' && standing.knocks).toEqual([]);
  });

  it('tells the people at the door whether anyone is there to answer it', async () => {
    const { client: owner, world } = await join('ridham');
    const { client: nina } = await join('nina');
    await setJoinMode(owner, 'knock');
    await nina.next((m) => m.type === 'workspace');

    const sam = await arrive(world.roomCode, 'sam');
    const greeted = await sam.next((m) => m.type === 'knocking');
    expect(greeted.type === 'knocking' && greeted.answerable).toBe(true);

    // Nina never leaves — and an ordinary member cannot open the door, so
    // with the owner gone there is nobody who can hear sam at all.
    owner.close();
    const alone = await sam.next((m) => m.type === 'knocking');
    expect(alone.type === 'knocking' && alone.answerable).toBe(false);

    // Somebody arriving now is told in the first word, rather than waiting
    // for an answer that changes under them.
    const theo = await arrive(world.roomCode, 'theo');
    const greetedAlone = await theo.next((m) => m.type === 'knocking');
    expect(greetedAlone.type === 'knocking' && greetedAlone.answerable).toBe(false);

    // The owner comes back on a fresh tab. Both of them learn it where they
    // stand, without reloading anything.
    const ownerAgain = new WebClientHarness(server.port);
    clients.push(ownerAgain);
    await ownerAgain.open();
    ownerAgain.send({
      type: 'join',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    for (const waiting of [sam, theo]) {
      const answered = await waiting.next((m) => m.type === 'knocking');
      expect(answered.type === 'knocking' && answered.answerable).toBe(true);
    }
  });

  it('lets a knocker refused at the door try again under a free name', async () => {
    const { client: owner, world } = await join('ridham');
    await setJoinMode(owner, 'knock');

    // Two people queue up calling themselves the same thing. Whoever is let
    // in first takes the name; knocking never reserved it.
    const visitor = await arrive(world.roomCode, 'sam');
    await visitor.next((m) => m.type === 'knocking');
    const rival = await arrive(world.roomCode, 'sam');
    await rival.next((m) => m.type === 'knocking');

    const queue = await owner.next((m) => m.type === 'knocks' && m.knocks.length === 2);
    if (queue.type !== 'knocks') throw new Error('unreachable');
    const [early, late] = queue.knocks;
    if (!early || !late) throw new Error('both knocks should be queued');

    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: late.id } });
    await rival.next((m) => m.type === 'world');

    // Now the first one cannot be let in under that name, and is told so.
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: early.id } });
    const refused = await visitor.next((m) => m.type === 'error');
    expect(refused.type === 'error' && refused.code).toBe('name-taken');

    // The queue does not keep an entry nobody can act on, and the moderator
    // learns their op did not land.
    const emptied = await owner.next((m) => m.type === 'knocks' && m.knocks.length === 0);
    expect(emptied.type === 'knocks' && emptied.knocks).toEqual([]);
    expect((await owner.next((m) => m.type === 'error')).type).toBe('error');

    // And the person behind that socket is free to offer another name.
    visitor.send({ type: 'join', roomCode: world.roomCode, displayName: 'sammy' });
    await visitor.next((m) => m.type === 'knocking');
    const retry = await firstKnock(owner);
    expect(retry.displayName).toBe('sammy');
    owner.send({ type: 'admin', op: { kind: 'knock-admit', knockId: retry.id } });
    const admitted = await visitor.next((m) => m.type === 'world');
    expect(admitted.type === 'world' && admitted.you.memberSecret).toBeTruthy();
  });

  it('turns a lifted ban into a door somebody can actually walk through', async () => {
    const { client: owner, world } = await join('ridham');
    const { client: sam, world: samWorld } = await join('sam');
    const credentials = {
      type: 'join',
      memberId: samWorld.you.memberId,
      memberSecret: samWorld.you.memberSecret,
    };

    owner.send({ type: 'admin', op: { kind: 'ban', memberId: samWorld.you.memberId } });
    const shown = await sam.next((m) => m.type === 'removed');
    expect(shown.type === 'removed' && shown.reason).toBe('banned');

    // While the ban stands, the office says so rather than coaching them
    // round it. Their own secret is what unlocks the answer, so nothing here
    // is readable by anybody else.
    const duringBan = new WebClientHarness(server.port);
    clients.push(duringBan);
    await duringBan.open();
    duringBan.send(credentials);
    const refusedBanned = await duringBan.next((m) => m.type === 'error');
    if (refusedBanned.type !== 'error') throw new Error('unreachable');
    expect(refusedBanned.code).toBe('bad-join');
    expect(refusedBanned.message).toContain('banned');
    expect(refusedBanned.message).not.toContain('pick a name');

    owner.send({ type: 'admin', op: { kind: 'unban', memberId: samWorld.you.memberId } });
    await owner.next((m) => m.type === 'roster' && m.members.some((r) => r.status === 'kicked'));

    // The credentials stay dead — the tombstone is what keeps the freed name
    // from colliding, and reviving it was never the promise. The promise was
    // the door, so the refusal has to point at it.
    const stale = new WebClientHarness(server.port);
    clients.push(stale);
    await stale.open();
    stale.send(credentials);
    const refused = await stale.next((m) => m.type === 'error');
    if (refused.type !== 'error') throw new Error('unreachable');
    expect(refused.code).toBe('bad-join');
    expect(refused.message).toContain('pick a name');

    // And the invite is the capability: same link, same name, fresh member.
    const back = await arrive(world.roomCode, 'sam');
    const again = (await back.next((m) => m.type === 'world')) as WebWorld;
    expect(again.you.memberId).not.toBe(samWorld.you.memberId);
    expect(again.you.memberSecret).toBeTruthy();
  });

  it('hands an ownerless office to whoever is left rather than sealing it shut', async () => {
    const { client: owner, world } = await join('ridham');
    const { client: nina, world: ninaWorld } = await join('nina');
    const { world: samWorld } = await join('sam');
    owner.send({ type: 'admin', op: { kind: 'promote', memberId: ninaWorld.you.memberId } });
    await owner.next((m) => m.type === 'member' && m.member.role === 'moderator');
    await setJoinMode(owner, 'knock');

    // The way an office actually loses its owner: whoever set it up never
    // paired a device and stopped coming back. Nothing in the knock door
    // would ever adopt, so without a repair the room is sealed for good.
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    server.db
      .prepare('UPDATE members SET created_at = ?, last_seen_at = ? WHERE id = ?')
      .run(old, old, world.you.memberId);
    server.db.prepare('UPDATE workspaces SET created_at = ?').run(old);
    server.rooms.cleanupStaleMembers();

    // The moderator the owner themselves promoted inherits, ahead of the
    // longer-standing plain member — and the people inside are told.
    const inherited = await nina.next((m) => m.type === 'member' && m.member.role === 'owner');
    expect(inherited.type === 'member' && inherited.member.id).toBe(ninaWorld.you.memberId);
    expect(server.rooms.memberById(samWorld.you.memberId)?.role).toBe('member');

    // Which is the whole point: the door opens again.
    const visitor = await arrive(world.roomCode, 'theo');
    const waiting = await visitor.next((m) => m.type === 'knocking');
    expect(waiting.type === 'knocking' && waiting.answerable).toBe(true);
    const knock = await firstKnock(nina);
    nina.send({ type: 'admin', op: { kind: 'knock-admit', knockId: knock.id } });
    expect((await visitor.next((m) => m.type === 'world')).type).toBe('world');
  });

  it('writes an audit row for an office that changed hands with nobody clicking', async () => {
    const { client: owner, world } = await join('ridham');
    const { world: samWorld } = await join('sam');

    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    server.db
      .prepare('UPDATE members SET created_at = ?, last_seen_at = ? WHERE id = ?')
      .run(old, old, world.you.memberId);
    server.db.prepare('UPDATE workspaces SET created_at = ?').run(old);
    server.rooms.cleanupStaleMembers();
    await owner.waitClosed();

    // "Who made *them* the owner?" is the argument a friend group has, and
    // the only honest answer is a row that says nobody did.
    const events = server.rooms.events(server.rooms.getRoom(world.roomCode)?.id ?? '');
    const adopted = events.find((e) => e.action === 'workspace.adopt');
    expect(adopted?.targetId).toBe(samWorld.you.memberId);
    expect(adopted?.actorId).toBeNull();
  });

  it('pair → redeem → collector snapshot → browser sees sessions and leaderboard', async () => {
    const { client, world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    expect(mint.status).toBe(200);
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    expect(pairingCode).toMatch(/^[2-9A-Z]{3}-[2-9A-Z]{3}$/);

    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: pairingCode.toLowerCase() }),
    });
    expect(redeem.status).toBe(200);
    const paired = (await redeem.json()) as PairRedeemResponse;
    expect(paired.displayName).toBe('ridham');

    // Codes are one-shot.
    const again = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    expect(again.status).toBe(404);

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.1.0' }),
    );
    await new Promise<void>((resolve) => collector.once('message', () => resolve()));

    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-1',
            harness: 'claude-code',
            state: 'working',
            title: 'Building the office',
            project: 'sloppers',
            model: 'claude-fable-5',
            tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 },
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
          },
        ],
        machine: { idleSeconds: 10 },
      }),
    );

    const presence = await client.next((m) => m.type === 'presence');
    if (presence.type !== 'presence') throw new Error('unreachable');
    expect(presence.sessions[0]?.title).toBe('Building the office');
    expect(presence.presence).toBe('active');
    expect(presence.today.tokens.input).toBe(1000);

    const leaderboard = await client.next((m) => m.type === 'leaderboard', 8000);
    if (leaderboard.type !== 'leaderboard') throw new Error('unreachable');
    expect(leaderboard.rows[0]?.stats.tokens.output).toBe(200);

    collector.close();
  });

  /**
   * A member who turned token sharing off, with sessions running.
   *
   * `applyVisibility` drops `tokens`, `usage` and `activeMinutes` in the
   * collector, so nothing reaches the ledger and every number the server holds
   * for them is zero — a truthful zero about an empty table and a false one
   * about a person. Their card listed their live sessions and, underneath,
   * claimed `0 tok / 0 sessions / est. $0.00`; the board dropped them into the
   * same gap as somebody who had not started yet.
   *
   * The only thing that can tell those apart is the snapshot envelope, because
   * a brand-new session that has not produced a token yet is byte-identical to
   * a withheld one. This is the whole path: collector states it, ledger stays
   * out of it, both the member view and the leaderboard row carry it.
   */
  it('carries a refusal to share numbers through to the card and the board', async () => {
    const { client, world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.2.0' }),
    );
    await new Promise<void>((resolve) => collector.once('message', () => resolve()));

    collector.send(
      JSON.stringify({
        type: 'snapshot',
        // A live session with every token field stripped — exactly what
        // `applyVisibility` emits when `visibility.tokens` is off.
        sessions: [
          {
            id: 'sess-quiet',
            harness: 'codex',
            state: 'working',
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
        sharesTokens: false,
      }),
    );

    const presence = await client.next((m) => m.type === 'presence');
    if (presence.type !== 'presence') throw new Error('unreachable');
    expect(presence.sessions).toHaveLength(1);
    expect(presence.today.tokensShared).toBe(false);
    // The zeroes are still there and still true about the tables. What has
    // changed is that they are no longer the only thing on the wire.
    expect(presence.today.sessionsRun).toBe(0);

    const leaderboard = await client.next((m) => m.type === 'leaderboard', 8000);
    if (leaderboard.type !== 'leaderboard') throw new Error('unreachable');
    expect(leaderboard.rows[0]?.stats.tokensShared).toBe(false);

    collector.close();
  });

  /**
   * Pair a collector to a member and get a live socket for it — the four-step
   * mint/redeem/hello dance the tests around this one write out longhand.
   */
  async function pairCollector(world: WebWorld, collectorVersion = '0.2.0'): Promise<WebSocket> {
    const base = `http://127.0.0.1:${server.port}`;
    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;
    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion }),
    );
    await new Promise<void>((resolve) => collector.once('message', () => resolve()));
    return collector;
  }

  it('answers a history request with the office’s recent days', async () => {
    const { client, world } = await join('ridham');
    const collector = await pairCollector(world);
    const today = dayOf(Date.now());
    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-1',
            harness: 'claude-code',
            state: 'working',
            usage: [
              {
                day: today,
                model: 'claude-fable-5',
                input: 900,
                output: 100,
                cacheRead: 0,
                cacheWrite: 0,
              },
            ],
            tokens: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0 },
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
      }),
    );
    await client.next((m) => m.type === 'presence');

    client.send({ type: 'history' });
    const history = await client.next((m) => m.type === 'history');
    if (history.type !== 'history') throw new Error('unreachable');
    // A week by default, newest first, and the newest key is the day the live
    // board is already calling today — one definition of today per panel.
    expect(history.days).toHaveLength(7);
    expect(history.days[0]).toBe(today);
    const mine = history.members.find((m) => m.memberId === world.you.memberId);
    expect(mine?.days).toHaveLength(7);
    expect(mine?.days[0]?.day).toBe(today);
    expect(mine?.days[0]?.stats.tokens.input).toBe(900);
    // Every other day is a real zero rather than a missing entry — this office
    // opened a minute ago and its strip should say so by being flat.
    expect(mine?.days[1]?.stats.tokens.input).toBe(0);

    collector.close();
  });

  /**
   * Withholding governs the past tense too, and from the present.
   *
   * Somebody who turns sharing off at lunch is not asking the office to keep
   * quiet from lunchtime on — they are asking it to stop talking about their
   * numbers, and this morning's are still their numbers. The rows are still in
   * the ledger (they were shared when they were written, and turning sharing
   * off does not unsend them), so the guard has to be on the read.
   *
   * Both halves are asserted on purpose: the first proves the days are really
   * there to be leaked, so the second cannot pass by accident.
   */
  it('withholds a member’s history the moment they withhold their numbers', async () => {
    const { client, world } = await join('ridham');
    const collector = await pairCollector(world);
    const today = dayOf(Date.now());
    const session = {
      id: 'sess-1',
      harness: 'claude-code',
      state: 'working',
      usage: [
        {
          day: today,
          model: 'claude-fable-5',
          input: 4242,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
      tokens: { input: 4242, output: 0, cacheRead: 0, cacheWrite: 0 },
      startedAt: Date.now() - 60_000,
      lastActivityAt: Date.now(),
    };
    collector.send(JSON.stringify({ type: 'snapshot', sessions: [session], machine: {} }));
    await client.next((m) => m.type === 'presence');

    client.send({ type: 'history' });
    const shared = await client.next((m) => m.type === 'history');
    if (shared.type !== 'history') throw new Error('unreachable');
    expect(shared.members[0]?.days[0]?.stats.tokens.input).toBe(4242);
    expect(shared.members[0]?.tokensShared).toBeUndefined();

    // Sharing off. Same session, same rows in the table, nothing deleted.
    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-1',
            harness: 'claude-code',
            state: 'working',
            startedAt: session.startedAt,
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
        sharesTokens: false,
      }),
    );
    await client.next((m) => m.type === 'presence' && m.today.tokensShared === false);

    client.send({ type: 'history' });
    const withheld = await client.next((m) => m.type === 'history');
    if (withheld.type !== 'history') throw new Error('unreachable');
    expect(withheld.members[0]?.tokensShared).toBe(false);
    expect(withheld.members[0]?.days).toEqual([]);
    // Not "sent and flagged": the number does not leave the server at all.
    expect(JSON.stringify(withheld)).not.toContain('4242');

    collector.close();
  });

  it('refuses a history request that has spent its budget', async () => {
    const { client } = await join('ridham');
    // Five in a burst is the whole budget; a client that caches its answer
    // spends one per connection, so anything past this is a loop.
    for (let i = 0; i < 5; i++) {
      client.send({ type: 'history' });
      await client.next((m) => m.type === 'history');
    }
    client.send({ type: 'history' });
    const refused = await client.next((m) => m.type === 'history' || m.type === 'error');
    expect(refused.type).toBe('error');
    if (refused.type !== 'error') throw new Error('unreachable');
    expect(refused.message).toBe('slow down');
  });

  it('leaves a member who is gone out of the office’s history', async () => {
    const { client: owner, world: ownerWorld } = await join('ridham');
    const { world: samWorld } = await join('sam');
    await owner.next((m) => m.type === 'member');

    owner.send({ type: 'admin', op: { kind: 'kick', memberId: samWorld.you.memberId } });
    await owner.next((m) => m.type === 'member-left');

    owner.send({ type: 'history' });
    const history = await owner.next((m) => m.type === 'history');
    if (history.type !== 'history') throw new Error('unreachable');
    // History is the room's, and the room no longer contains them. Their rows
    // survive in the tables for attribution; nothing asks the office to keep
    // showing a week for somebody who is not in it.
    expect(history.members.map((m) => m.memberId)).toEqual([ownerWorld.you.memberId]);
  });

  it('reads silence from a 0.1.x collector as sharing, never as withholding', async () => {
    // The published collector cannot say either way. Treating absence as a
    // refusal would relabel every member who has not upgraded — which today is
    // all of them.
    const { client, world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.1.1' }),
    );
    await new Promise<void>((resolve) => collector.once('message', () => resolve()));

    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-old',
            harness: 'claude-code',
            state: 'working',
            tokens: { input: 10, output: 20, cacheRead: 3000, cacheWrite: 40 },
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
      }),
    );

    const presence = await client.next((m) => m.type === 'presence');
    if (presence.type !== 'presence') throw new Error('unreachable');
    expect(presence.today.tokensShared).toBeUndefined();
    // And its day is coarse: flat watermarks, so per-file sessions and the
    // server's own minute marks.
    expect(presence.today.precision).toBe('coarse');

    collector.close();
  });

  /**
   * The seam behind "the share dialog has no success state". `sharing` rides
   * on the member view and on nothing else — a `presence` message carries
   * presence, sessions and today's totals, none of which need have changed
   * when a collector with no live session attaches — so the browser that had
   * just handed somebody the pairing command learned nothing at all until it
   * was reloaded. There was no event for the dialog to notice.
   */
  it('tells the browser the moment a collector attaches, not only on reload', async () => {
    const { client, world } = await join('ridham');
    expect(world.members[0]?.sharing).toBe(false);
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.1.0' }),
    );
    await new Promise<void>((resolve) => collector.once('message', () => resolve()));

    // No snapshot sent, deliberately: pairing is news on its own, and the
    // person watching for it has not started an agent yet. The hello also
    // re-announces the member row itself, which is still `sharing: false` at
    // that point — so this waits for the flag, not merely for a message.
    const upsert = await client.next((m) => m.type === 'member' && m.member.sharing);
    if (upsert.type !== 'member') throw new Error('unreachable');
    expect(upsert.member.id).toBe(world.you.memberId);
    expect(upsert.member.sharing).toBe(true);

    collector.close();
  });

  /**
   * The other half of that seam, and the half that was missing. `sharing` went
   * up when a collector attached and never came back down — it meant "has ever
   * paired". So the HUD read "Sharing on" over a member card reading "no live
   * agent sessions right now": two sentences, each true on its own, telling one
   * lie together, for as long as the devices row survived.
   *
   * The office knows exactly when that machine goes; this is it saying so.
   */
  it('stops saying a member is sharing the moment their collector goes', async () => {
    const { client, world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.1.0' }),
    );
    await client.next((m) => m.type === 'member' && m.member.sharing);

    // The laptop shuts, the daemon stops, the heartbeat reaps a half-open
    // socket — from in here they are all the same event.
    collector.close();

    const dropped = await client.next((m) => m.type === 'member' && !m.member.sharing);
    if (dropped.type !== 'member') throw new Error('unreachable');
    expect(dropped.member.id).toBe(world.you.memberId);
    expect(dropped.member.sharing).toBe(false);
  });

  it('answers a snapshot it could not record instead of taking the server down', async () => {
    const { client: owner, world } = await join('ridham');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    const replies: { code?: string }[] = [];
    collector.on('message', (d) => replies.push(JSON.parse(String(d))));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.2.0' }),
    );
    await vi.waitFor(() => expect(replies).toHaveLength(1));

    // A database that will not take a write — busy, locked, read-only. The
    // ledger folds the whole snapshot in one transaction, so it fails whole,
    // and an escaping throw here is an uncaught exception in the process
    // serving every office.
    server.db.pragma('query_only = true');
    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-1',
            harness: 'claude-code',
            state: 'working',
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
      }),
    );

    // Told, not swallowed: a collector that hears nothing back assumes the
    // snapshot landed and stops resending what it holds.
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]?.code).toBe('server-error');

    // Both sockets are still up, and so is the process they share.
    expect(collector.readyState).toBe(WebSocket.OPEN);
    owner.send({ type: 'move', position: { x: 11, y: 11, dir: 'up', moving: false } });
    owner.send({ type: 'admin', op: { kind: 'roster' } });
    expect((await owner.next((m) => m.type === 'roster')).type).toBe('roster');

    // Nothing was lost by refusing it: the wire is cumulative, so the next
    // heartbeat restates the same totals and they land.
    server.db.pragma('query_only = false');
    collector.send(
      JSON.stringify({
        type: 'snapshot',
        sessions: [
          {
            id: 'sess-1',
            harness: 'claude-code',
            state: 'working',
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
          },
        ],
        machine: {},
      }),
    );
    const presence = await owner.next((m) => m.type === 'presence' && m.today.tokens.input === 10);
    expect(presence.type === 'presence' && presence.today.tokens.input).toBe(10);

    collector.close();
  });

  it('rejects an unknown device key', async () => {
    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: 'f'.repeat(48), collectorVersion: '0.1.0' }),
    );
    const reply = await new Promise<string>((resolve) =>
      collector.once('message', (d) => resolve(String(d))),
    );
    expect(JSON.parse(reply).code).toBe('unknown-device');
  });

  it('tells a removed member’s collector it was let go, not that its pairing is broken', async () => {
    const { client: owner } = await join('ridham');
    const { world: samWorld } = await join('sam');
    const base = `http://127.0.0.1:${server.port}`;

    const mint = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: samWorld.you.memberId,
        memberSecret: samWorld.you.memberSecret,
      }),
    });
    const { pairingCode } = (await mint.json()) as { pairingCode: string };
    const redeem = await fetch(`${base}/api/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode }),
    });
    const paired = (await redeem.json()) as PairRedeemResponse;

    owner.send({ type: 'admin', op: { kind: 'ban', memberId: samWorld.you.memberId } });
    await owner.next((m) => m.type === 'roster' && m.members.some((r) => r.status === 'banned'));

    // The device row survives a ban — only a delete erases it — so the
    // pairing on that machine is perfectly good and the office knows exactly
    // whose it is. Answering `unknown-device` makes the daemon delete its own
    // config and print a remedy the office would refuse.
    const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => collector.on('open', () => resolve()));
    collector.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.2.0' }),
    );
    const reply = await new Promise<string>((resolve) =>
      collector.once('message', (d) => resolve(String(d))),
    );
    const answer = JSON.parse(reply) as { code: string; message: string };
    expect(answer.code).toBe('member-removed');
    expect(answer.message).not.toContain('sloppers share');
    expect(answer.message).toContain('banned');
    collector.close();

    // A published 0.1.x collector cannot parse `member-removed` — its error
    // enum has four entries — so the message would be dropped and the close
    // read as a network blip: reconnect, forever. The one code it both
    // understands and terminally stops on is `superseded` (exit 0, config
    // kept, service files decline to restart a successful exit).
    const old = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
    await new Promise<void>((resolve) => old.on('open', () => resolve()));
    old.send(
      JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.1.1' }),
    );
    const oldReply = await new Promise<string>((resolve) =>
      old.once('message', (d) => resolve(String(d))),
    );
    expect((JSON.parse(oldReply) as { code: string }).code).toBe('superseded');
    old.close();
  });

  /**
   * Arriving after being away. The office decides, off its own record of who
   * was in the room — never off the browser's clock, and never off
   * `last_seen_at`, which a collector keeps warm for a laptop nobody is
   * looking at.
   */
  describe('while you were away', () => {
    /** Rewrite when the office last saw a browser of theirs, as the past. */
    function lastHere(memberId: string, msAgo: number): void {
      server.db
        .prepare('UPDATE members SET last_present_at = ? WHERE id = ?')
        .run(Date.now() - msAgo, memberId);
    }

    function presentAt(memberId: string): number {
      return (
        server.db
          .prepare('SELECT last_present_at AS at FROM members WHERE id = ?')
          .get(memberId) as {
          at: number;
        }
      ).at;
    }

    /**
     * Shut a tab and let the office notice. The close handler — which stamps
     * the presence clock — runs a tick or two later, so a test that rewound the
     * clock straight after `close()` would have its rewind written back over.
     */
    async function leave(client: WebClientHarness): Promise<void> {
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    /** Resume an identity on a fresh socket, the way a reopened tab does. */
    async function resume(world: WebWorld): Promise<WebWorld> {
      const back = new WebClientHarness(server.port);
      clients.push(back);
      await back.open();
      back.send({
        type: 'join',
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      });
      return (await back.next((m) => m.type === 'world')) as WebWorld;
    }

    it('names the day a returning member was last here', async () => {
      const { client, world } = await join('ridham');
      await leave(client);
      // A night: long enough, and across the office's midnight.
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);

      const back = await resume(world);
      expect(back.lastHereDay).toBe(
        dayIn(Date.now() - 14 * 60 * 60 * 1000, Intl.DateTimeFormat().resolvedOptions().timeZone),
      );
      expect(
        back.lastHereDay < dayIn(Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone),
      ).toBe(true);
    });

    it('says nothing to somebody whose tab blipped ninety seconds ago', async () => {
      const { client, world } = await join('ridham');
      await leave(client);
      lastHere(world.you.memberId, 90_000);

      expect((await resume(world)).lastHereDay).toBeUndefined();
    });

    it('says nothing to somebody arriving for the first time', async () => {
      // Nothing is rewritten here: a member minted seconds ago is stamped with
      // the present by `createMember`, so the first join is never a return.
      const { world } = await join('ridham');
      expect(world.lastHereDay).toBeUndefined();
    });

    /**
     * The duplicate the panel must never be. Greeted once, then the socket
     * drops and comes back — the office stamped them present on the way in, so
     * the second `world` carries nothing and the browser clears what it had.
     */
    it('greets a return once, and not again on the reconnect behind it', async () => {
      const { client, world } = await join('ridham');
      await leave(client);
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);

      const greeted = await resume(world);
      expect(greeted.lastHereDay).toBeTruthy();
      expect((await resume(world)).lastHereDay).toBeUndefined();
    });

    /**
     * The reason this needed a column of its own. `last_seen_at` is written by
     * a collector saying hello, so a member whose laptop reports all night
     * looks "seen" every few minutes — and would never be greeted for the one
     * absence the panel is best at describing.
     */
    it('is not fooled by a collector reporting through the night', async () => {
      const { client, world } = await join('ridham');
      const base = `http://127.0.0.1:${server.port}`;
      const mint = await fetch(`${base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memberId: world.you.memberId,
          memberSecret: world.you.memberSecret,
        }),
      });
      const { pairingCode } = (await mint.json()) as { pairingCode: string };
      const redeem = await fetch(`${base}/api/pair/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode }),
      });
      const paired = (await redeem.json()) as PairRedeemResponse;

      await leave(client);
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);
      server.db
        .prepare('UPDATE members SET last_seen_at = ? WHERE id = ?')
        .run(Date.now() - 14 * 60 * 60 * 1000, world.you.memberId);

      const collector = new WebSocket(`ws://127.0.0.1:${server.port}/ws/collector`);
      await new Promise<void>((resolve) => collector.on('open', () => resolve()));
      collector.send(
        JSON.stringify({ type: 'hello', deviceKey: paired.deviceKey, collectorVersion: '0.2.0' }),
      );
      await new Promise<void>((resolve) => collector.once('message', () => resolve()));

      // The hello moved `last_seen_at` to now and left the presence clock
      // where it was — so the office still knows nobody has been in the room.
      const row = server.db
        .prepare('SELECT last_seen_at, last_present_at FROM members WHERE id = ?')
        .get(world.you.memberId) as { last_seen_at: number; last_present_at: number };
      expect(row.last_seen_at).toBeGreaterThan(row.last_present_at);
      expect((await resume(world)).lastHereDay).toBeTruthy();
      collector.close();
    });

    /**
     * A tab held open all day is somebody who is *here*, continuously. Without
     * the sweep writing that through, opening a second tab at six would be
     * greeted for an absence spent sitting in the room.
     */
    it('keeps the clock warm while a browser is actually in the office', async () => {
      const { world } = await join('ridham');
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);

      // The sweep a minute from now — the first one past the write-through
      // interval, with this tab still sitting in the office. Named as a moment
      // rather than waiting for one, because the alternative is a test that
      // takes a real minute.
      const sweepAt = Date.now() + 61_000;
      server.rooms.sweep(sweepAt);
      expect(presentAt(world.you.memberId)).toBe(sweepAt);

      // Which is what a second tab opening measures against: no absence.
      expect((await resume(world)).lastHereDay).toBeUndefined();
    });

    /**
     * The write-through is throttled, not run every sweep. A second sweep
     * inside the interval must leave the row where the first put it — deleting
     * the interval guard would write every member every sweep, invisible to
     * the test above because the value only ever grows.
     */
    it('leaves the clock alone between write-through intervals', async () => {
      const { world } = await join('ridham');
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);

      const sweepAt = Date.now() + 61_000;
      server.rooms.sweep(sweepAt);
      expect(presentAt(world.you.memberId)).toBe(sweepAt);

      // Thirty seconds on, still inside the sixty-second interval: no write.
      server.rooms.sweep(sweepAt + 30_000);
      expect(presentAt(world.you.memberId)).toBe(sweepAt);
    });

    /**
     * The other single-line deletion that used to leave every test green:
     * dropping the connected-tab guard stamps *everyone* present on every
     * sweep, which quietly disables the whole feature — nobody is ever away.
     */
    it('does not keep a row warm for a member with no tab in the office', async () => {
      const { client, world } = await join('ridham');
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);
      const before = presentAt(world.you.memberId);
      await leave(client);
      const stamped = presentAt(world.you.memberId);
      expect(stamped).toBeGreaterThanOrEqual(before);

      // Gone for a minute-plus; the sweep must leave their row exactly where
      // the close stamped it.
      server.rooms.sweep(Date.now() + 61_000);
      expect(presentAt(world.you.memberId)).toBe(stamped);
    });

    /** And the close stamps it, so a tab shut and reopened is no absence. */
    it('stamps the moment the last tab closes', async () => {
      const { client, world } = await join('ridham');
      lastHere(world.you.memberId, 14 * 60 * 60 * 1000);
      await leave(client);

      expect(presentAt(world.you.memberId)).toBeGreaterThan(Date.now() - 5_000);
      expect((await resume(world)).lastHereDay).toBeUndefined();
    });
  });

  /**
   * People talking to each other — the one thing the office could not do.
   *
   * Everything in here is about the two properties the rest of this wire does
   * not have: a message is written before it is broadcast, and it came from a
   * person rather than from a machine. So the cases are the ones that only
   * matter for writing (it survives the office going to sleep; deleting
   * somebody takes their side of it with them) and the ones that only matter
   * for authorship (nobody who is not in the room can say anything; the
   * refusal reaches the text box; a line can be taken back).
   */
  describe('chat', () => {
    /** Walk in, and keep the conversation the office hands over on the way. */
    async function stepIn(
      roomCode: string,
      displayName: string,
    ): Promise<{ client: WebClientHarness; world: WebWorld; log: WebChatLog }> {
      const client = await arrive(roomCode, displayName);
      const entered = (await client.next((m) => m.type === 'world')) as WebWorld;
      const log = await client.next((m) => m.type === 'chat-log');
      if (log.type !== 'chat-log') throw new Error('unreachable');
      return { client, world: entered, log };
    }

    /** Come back as somebody who already has a seat, and read the backlog. */
    async function comeBack(
      world: WebWorld,
    ): Promise<{ client: WebClientHarness; log: WebChatLog }> {
      const client = new WebClientHarness(server.port);
      clients.push(client);
      await client.open();
      client.send({
        type: 'join',
        memberId: world.you.memberId,
        memberSecret: world.you.memberSecret,
      });
      await client.next((m) => m.type === 'world');
      const log = await client.next((m) => m.type === 'chat-log');
      if (log.type !== 'chat-log') throw new Error('unreachable');
      return { client, log };
    }

    /**
     * Say something and wait for the office's own copy of it to come back.
     *
     * Matched on the text rather than on "the next chat message", because this
     * socket may already be holding somebody else's line — and a helper that
     * hands back the wrong message makes every assertion after it a
     * coincidence.
     */
    async function say(client: WebClientHarness, text: string): Promise<ChatMessage> {
      const flattened = normalizeChatText(text);
      client.send({ type: 'chat', text });
      const heard = await client.next((m) => m.type === 'chat' && m.message.text === flattened);
      if (heard.type !== 'chat') throw new Error('unreachable');
      return heard.message;
    }

    /** Close a tab and let the server's close handler actually run. */
    async function shut(client: WebClientHarness): Promise<void> {
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    /** Every line the database is holding, oldest first. */
    function stored(): { member_id: string; body: string }[] {
      return server.db
        .prepare('SELECT member_id, body FROM chat_messages ORDER BY at, rowid')
        .all() as { member_id: string; body: string }[];
    }

    it('carries one person’s line to the whole office, the sender included', async () => {
      const { client: a } = await join('ridham');
      const { client: b } = await join('sam');

      a.send({ type: 'chat', text: 'shipped it, look at the board' });
      const mine = await a.next((m) => m.type === 'chat');
      const theirs = await b.next((m) => m.type === 'chat');

      // The author's own copy is the office's, not a local echo: same id, same
      // moment, same text. It is what tells them the sentence actually landed.
      expect(mine).toEqual(theirs);
      if (theirs.type !== 'chat') throw new Error('unreachable');
      expect(theirs.message.displayName).toBe('ridham');
      expect(theirs.message.text).toBe('shipped it, look at the board');
    });

    it('flattens a message to one line and stores exactly what it broadcast', async () => {
      const { client: a } = await join('ridham');
      const message = await say(a, '  one\n\ntwo\tthree  ');
      expect(message.text).toBe('one two three');
      expect(stored().map((r) => r.body)).toEqual(['one two three']);
    });

    /**
     * Markup is text and nothing else touches it. The office must not "clean"
     * it either — a chat that silently rewrites what somebody typed is its own
     * kind of lie, and the escaping belongs in the one place that renders it.
     */
    it('keeps markup as the characters it is', async () => {
      const { client: a } = await join('ridham');
      const nasty = '<script>alert(1)</script> & <img src=x onerror=1>';
      expect((await say(a, nasty)).text).toBe(nasty);
      expect(stored()[0]?.body).toBe(nasty);
    });

    it('refuses a message with nothing left in it, in chat’s own channel', async () => {
      const { client: a } = await join('ridham');
      // Passes the schema's `min(1)` and is empty by the time it is a message.
      a.send({ type: 'chat', text: '  \t ' });
      const refused = await a.next((m) => m.type === 'error');
      expect(refused.type === 'error' && refused.code).toBe('chat-refused');
      expect(stored()).toHaveLength(0);
    });

    it('takes a message at the cap and refuses one past it', async () => {
      const { client: a } = await join('ridham');
      expect((await say(a, 'x'.repeat(MAX_CHAT_LENGTH))).text).toHaveLength(MAX_CHAT_LENGTH);

      a.send({ type: 'chat', text: 'x'.repeat(MAX_CHAT_LENGTH + 1) });
      const refused = await a.next((m) => m.type === 'error');
      // The schema's refusal, which is the same one every malformed message
      // gets — a browser cannot produce this, `maxLength` truncates the paste.
      expect(refused.type === 'error' && refused.code).toBe('bad-message');
      expect(stored()).toHaveLength(1);
    });

    /**
     * The guard that keeps this from being an open write endpoint. A socket
     * that has connected and said nothing is not in the office, and the only
     * evidence either way is that nothing it says is ever heard or kept.
     */
    it('hears nothing from a socket that never joined', async () => {
      const { client: owner } = await join('ridham');
      const { client: sam } = await join('sam');

      const stranger = new WebClientHarness(server.port);
      clients.push(stranger);
      await stranger.open();
      stranger.send({ type: 'chat', text: 'i am not here' });

      // Sam's line is the marker: it is sent strictly after the stranger's, so
      // a leaked message cannot be hiding behind it.
      sam.send({ type: 'chat', text: 'actually here' });
      const heard = await owner.next((m) => m.type === 'chat');
      expect(heard.type === 'chat' && heard.message.text).toBe('actually here');
      expect(stored().map((r) => r.body)).toEqual(['actually here']);
    });

    /**
     * And somebody still waiting at the door is not in the conversation —
     * being let in is the whole thing they are standing there for.
     *
     * The owner's own line is the marker rather than a filter, because a leak
     * that broadcast without writing would slip past a check on the table
     * alone. The knocker's message is sent strictly first, so if anything at
     * all got through, it is what arrives here.
     */
    it('hears nothing from a socket knocking at the door', async () => {
      const { client: owner, world } = await join('ridham');
      await setJoinMode(owner, 'knock');

      const knocker = await arrive(world.roomCode, 'sam');
      expect((await knocker.next((m) => m.type === 'knocking')).type).toBe('knocking');
      knocker.send({ type: 'chat', text: 'let me in' });

      owner.send({ type: 'chat', text: 'nobody home' });
      const first = await owner.next((m) => m.type === 'chat');
      expect(first.type === 'chat' && first.message.text).toBe('nobody home');
      expect(stored().map((r) => r.body)).toEqual(['nobody home']);
    });

    it('hands an arriving browser the conversation it walked into', async () => {
      const { client: owner, world } = await join('ridham');
      await say(owner, 'first');
      await say(owner, 'second');

      const { log } = await stepIn(world.roomCode, 'sam');
      expect(log.messages.map((m) => m.text)).toEqual(['first', 'second']);
      // A member minted this second has been here since they existed, so
      // nothing in the room is news to them. Greeting a newcomer with a "new"
      // rule over a conversation they were never in would be nonsense.
      expect(log.unreadSince).toBeUndefined();
    });

    /**
     * The whole of the "last N" decision in one test. A reload and a week away
     * look identical to a socket, and only one of them wants an empty panel —
     * so both get the same backlog, and the *mark* is what tells them apart.
     */
    it('marks what somebody missed, and marks nothing on a reload', async () => {
      const { client: owner } = await join('ridham');
      const { client: sam, world: samWorld } = await join('sam');
      const seen = await say(owner, 'before you left');

      await shut(sam);
      // Pinned to the last line they were here for rather than raced against
      // the close. `at > last_present_at` is strict, so this is exactly "they
      // saw that one" — and the pause is what keeps the next line from
      // landing in the same millisecond and reading as seen too.
      server.db
        .prepare('UPDATE members SET last_present_at = ? WHERE id = ?')
        .run(seen.at, samWorld.you.memberId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const missed = await say(owner, 'after you left');

      const back = await comeBack(samWorld);
      expect(back.log.messages.map((m) => m.text)).toEqual(['before you left', 'after you left']);
      expect(back.log.unreadSince).toBe(missed.at);

      // Straight back in again: the arrival above stamped them present, so
      // there is nothing to mark and the panel does not re-announce itself.
      await shut(back.client);
      const again = await comeBack(samWorld);
      expect(again.log.messages).toHaveLength(2);
      expect(again.log.unreadSince).toBeUndefined();
    });

    it('answers both tabs of one member, and only the arriving one with a backlog', async () => {
      const { client: first, world } = await join('ridham');
      await say(first, 'said on the first tab');

      const second = await comeBack(world);
      expect(second.log.messages.map((m) => m.text)).toEqual(['said on the first tab']);

      // A broadcast reaches every tab; the backlog reached only the new one.
      // The second tab's line is the marker — everything the resume sent to
      // the first tab is strictly before it, so a backlog that had leaked
      // across cannot be hiding behind it. It matters: a `chat-log` landing on
      // a tab somebody is reading would replace what is on screen.
      second.client.send({ type: 'chat', text: 'and on the second' });
      const heard: string[] = [];
      let msg: ServerToWeb;
      do {
        msg = await first.next();
        heard.push(msg.type);
      } while (msg.type !== 'chat');
      expect(heard).not.toContain('chat-log');
      expect(msg.type === 'chat' && msg.message.text).toBe('and on the second');
    });

    /**
     * The budget, as a socket actually meets it. The exact numbers are pinned
     * in `rate-limit.test.ts`; what matters here is that a burst lands, that a
     * script is stopped, and that the refusal is the chat-shaped one — a
     * `bad-message` here would be routed to the admin panel, which the person
     * typing may not even have open.
     */
    it('lets a burst through, then tells a flood to slow down and hangs up', async () => {
      const { client: a } = await join('ridham');
      for (let i = 0; i < 20; i++) a.send({ type: 'chat', text: `line ${i}` });

      let delivered = 0;
      for (;;) {
        const msg = await a.next();
        if (msg.type === 'error') {
          expect(msg.code).toBe('chat-refused');
          break;
        }
        if (msg.type === 'chat') delivered += 1;
      }
      // Ten in one breath is more than anybody types; twenty is not a person.
      expect(delivered).toBeGreaterThanOrEqual(10);
      expect(delivered).toBeLessThan(20);
      // Ignoring the refusal and carrying on is what ends the connection.
      await a.waitClosed();
    });

    it('answers a failing chat instead of taking the whole server down', async () => {
      const { client: a } = await join('ridham');
      const { client: b } = await join('sam');

      // The table out from under the write. An escaping throw here is an
      // uncaught exception in the process serving every office on the server.
      server.db.exec('DROP TABLE chat_messages');
      a.send({ type: 'chat', text: 'into the void' });
      const failed = await a.next((m) => m.type === 'error');
      expect(failed.type === 'error' && failed.code).toBe('chat-refused');

      // That socket still works, and so does everyone else's.
      b.send({ type: 'move', position: { x: 100, y: 100, dir: 'up', moving: false } });
      expect((await a.next((m) => m.type === 'pos')).type).toBe('pos');
    });

    it('lets a moderator take a line down, and a plain member take back their own', async () => {
      const { client: owner } = await join('ridham');
      const { client: sam } = await join('sam');
      const { client: nina } = await join('nina');

      const samSaid = await say(sam, 'my api key is hunter2');
      const ninaSaid = await say(nina, 'still here');

      // A plain member may not edit somebody else out of the conversation.
      nina.send({ type: 'admin', op: { kind: 'chat-delete', messageId: samSaid.id } });
      const refused = await nina.next((m) => m.type === 'error');
      expect(refused.type === 'error' && refused.code).toBe('forbidden');
      expect(stored()).toHaveLength(2);

      // Their own, they may — which is the case that actually comes up.
      sam.send({ type: 'admin', op: { kind: 'chat-delete', messageId: samSaid.id } });
      const gone = await owner.next((m) => m.type === 'chat-removed');
      expect(gone.type === 'chat-removed' && gone.id).toBe(samSaid.id);
      expect(stored().map((r) => r.body)).toEqual(['still here']);

      // And the owner may take anybody's.
      owner.send({ type: 'admin', op: { kind: 'chat-delete', messageId: ninaSaid.id } });
      await owner.next((m) => m.type === 'chat-removed');
      expect(stored()).toHaveLength(0);

      // A line that is already gone is an ordinary answer, not a crash: two
      // moderators can reach for the same message.
      owner.send({ type: 'admin', op: { kind: 'chat-delete', messageId: ninaSaid.id } });
      const twice = await owner.next((m) => m.type === 'error');
      expect(twice.type === 'error' && twice.code).toBe('bad-message');
    });

    it('refuses a delete aimed at a message in another office', async () => {
      const { client: owner } = await join('ridham');
      const mine = await say(owner, 'said in the lab');

      const elsewhere = await openOfficeIn('the annex', 'UTC');
      elsewhere.send({ type: 'admin', op: { kind: 'chat-delete', messageId: mine.id } });
      const refused = await elsewhere.next((m) => m.type === 'error');
      expect(refused.type === 'error' && refused.code).toBe('bad-message');
      expect(stored().map((r) => r.body)).toContain('said in the lab');
    });

    /**
     * "Delete me" has to mean the office stops holding what you wrote, or it
     * does not mean much. The erase list in the manager is what does it, and
     * this is what fails if `chat_messages` ever falls off that list.
     */
    it('takes a deleted member’s side of the conversation with them', async () => {
      const { client: owner } = await join('ridham');
      const { client: sam, world: samWorld } = await join('sam');
      await say(sam, 'mine');
      await say(owner, 'theirs');

      owner.send({ type: 'admin', op: { kind: 'delete', memberId: samWorld.you.memberId } });
      await owner.next((m) => m.type === 'member-left');
      expect(stored().map((r) => r.body)).toEqual(['theirs']);
    });

    /**
     * And a ban does not. Three verbs, three meanings: kicked is "you left",
     * banned is "you may not come back", deleted is "you were never here".
     * Quietly erasing half a thread other people were part of is not a ban,
     * and whoever wants one specific line gone already has a delete for it.
     */
    it('leaves a banned member’s words where they were said', async () => {
      const { client: owner, world } = await join('ridham');
      const { client: sam, world: samWorld } = await join('sam');
      await say(sam, 'said before the ban');

      owner.send({ type: 'admin', op: { kind: 'ban', memberId: samWorld.you.memberId } });
      await owner.next((m) => m.type === 'member-left');
      expect(stored().map((r) => r.body)).toEqual(['said before the ban']);

      // Still readable by somebody arriving afterwards, under the name it was
      // said under — which is why the name is stored on the line rather than
      // looked up from a member list that no longer has them in it.
      const { log } = await stepIn(world.roomCode, 'nina');
      expect(log.messages[0]?.displayName).toBe('sam');
    });

    /**
     * The decision this table exists for. The office runs scale-to-zero: the
     * machine genuinely stops when the last tab closes, which for a handful of
     * friends is most of the day and all of the night. A ring buffer in the
     * process would pass every other test in this file and lose the
     * conversation every single night.
     *
     * Its own server on a real file, because `:memory:` cannot be closed and
     * reopened — which is precisely the event being tested.
     */
    it('remembers the conversation across the office going to sleep', async () => {
      const dir = mkdtempSync(joinPath(tmpdir(), 'sloppers-chat-'));
      const dbPath = joinPath(dir, 'office.db');
      const overnight = await createSloppersServer({ port: 0, hostname: '127.0.0.1', dbPath });
      try {
        const before = new WebClientHarness(overnight.port);
        await before.open();
        before.send({ type: 'join', createRoom: 'the lab', displayName: 'ridham' });
        const world = (await before.next((m) => m.type === 'world')) as WebWorld;
        before.send({ type: 'chat', text: 'shipped it, look at the board' });
        await before.next((m) => m.type === 'chat');
        before.close();
        await overnight.close();

        // Morning. Same disk, new process, nobody in the room in between.
        const woken = await createSloppersServer({ port: 0, hostname: '127.0.0.1', dbPath });
        try {
          const after = new WebClientHarness(woken.port);
          await after.open();
          after.send({
            type: 'join',
            memberId: world.you.memberId,
            memberSecret: world.you.memberSecret,
          });
          await after.next((m) => m.type === 'world');
          const log = await after.next((m) => m.type === 'chat-log');
          if (log.type !== 'chat-log') throw new Error('unreachable');
          expect(log.messages.map((m) => m.text)).toEqual(['shipped it, look at the board']);
          after.close();
        } finally {
          await woken.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
