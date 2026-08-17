import {
  serverToWebSchema,
  type PairRedeemResponse,
  type ServerToWeb,
  type WebWorld,
} from '@sloppers/protocol';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    server = await createSloppersServer({ port: 0, hostname: '127.0.0.1', dbPath: ':memory:' });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await server.close();
  });

  async function join(name: string): Promise<{ client: WebClientHarness; world: WebWorld }> {
    const client = new WebClientHarness(server.port);
    clients.push(client);
    await client.open();
    client.send({ type: 'join', roomCode: 'lab', displayName: name });
    const world = (await client.next((m) => m.type === 'world')) as WebWorld;
    return { client, world };
  }

  it('join → world with self; second member appears to the first', async () => {
    const { client: a, world } = await join('ridham');
    expect(world.roomCode).toBe('lab');
    expect(world.you.memberSecret).toBeTruthy();
    expect(world.members).toHaveLength(1);

    const { world: worldB } = await join('sam');
    expect(worldB.members).toHaveLength(2);

    const upsert = await a.next((m) => m.type === 'member');
    expect(upsert.type === 'member' && upsert.member.displayName).toBe('sam');
  });

  it('rejects duplicate names but allows resume with credentials', async () => {
    const { world } = await join('ridham');
    const dupe = new WebClientHarness(server.port);
    clients.push(dupe);
    await dupe.open();
    dupe.send({ type: 'join', roomCode: 'lab', displayName: 'RIDHAM' });
    const err = await dupe.next((m) => m.type === 'error');
    expect(err.type === 'error' && err.code).toBe('name-taken');

    const resumed = new WebClientHarness(server.port);
    clients.push(resumed);
    await resumed.open();
    resumed.send({
      type: 'join',
      roomCode: 'lab',
      memberId: world.you.memberId,
      memberSecret: world.you.memberSecret,
    });
    const worldAgain = (await resumed.next((m) => m.type === 'world')) as WebWorld;
    expect(worldAgain.you.memberId).toBe(world.you.memberId);
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
