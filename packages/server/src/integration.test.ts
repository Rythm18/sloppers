import {
  type KnockView,
  type PairRedeemResponse,
  type ServerToWeb,
  serverToWebSchema,
  type WebWorld,
} from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
        : { type: 'join', createRoom: 'the lab', displayName: name },
    );
    const world = (await client.next((m) => m.type === 'world')) as WebWorld;
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
});
