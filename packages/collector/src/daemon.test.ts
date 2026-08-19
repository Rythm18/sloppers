import type { CollectorSnapshot, SessionSnapshot } from '@sloppers/protocol';
import { defaultVisibility, encodeMinutes } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import { buildDirtySnapshot, MinuteDirtyTracker } from './daemon.js';
import { CollectorClient, type CollectorSocket } from './net/client.js';

const DAY = '2026-08-19';
const OTHER_DAY = '2026-08-18';

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    harness: 'claude-code',
    state: 'working',
    startedAt: 1,
    lastActivityAt: 2,
    ...overrides,
  };
}

describe('MinuteDirtyTracker', () => {
  it('marks a day dirty the first time it is observed', () => {
    const tracker = new MinuteDirtyTracker();
    const reports = [{ day: DAY, minutes: encodeMinutes([1, 2]) }];
    tracker.observe('s1', reports);
    expect(tracker.filterDirty('s1', reports)).toEqual(reports);
  });

  it('does not re-mark a day dirty once its bitmap is confirmed sent', () => {
    const tracker = new MinuteDirtyTracker();
    const reports = [{ day: DAY, minutes: encodeMinutes([1, 2]) }];
    tracker.observe('s1', reports);
    tracker.confirmSent(new Map([['s1', new Set([DAY])]]));
    // Same bitmap observed again — nothing changed.
    tracker.observe('s1', reports);
    expect(tracker.filterDirty('s1', reports)).toEqual([]);
  });

  it('marks a day dirty again when its bitmap grows', () => {
    const tracker = new MinuteDirtyTracker();
    const first = [{ day: DAY, minutes: encodeMinutes([1, 2]) }];
    tracker.observe('s1', first);
    tracker.confirmSent(new Map([['s1', new Set([DAY])]]));

    const grown = [{ day: DAY, minutes: encodeMinutes([1, 2, 3]) }];
    tracker.observe('s1', grown);
    expect(tracker.filterDirty('s1', grown)).toEqual(grown);
  });

  it('confirmSent clears only the days actually included, not every dirty day', () => {
    const tracker = new MinuteDirtyTracker();
    const reports = [
      { day: DAY, minutes: encodeMinutes([1]) },
      { day: OTHER_DAY, minutes: encodeMinutes([2]) },
    ];
    tracker.observe('s1', reports);
    // Only DAY was actually handed to a connected client.
    tracker.confirmSent(new Map([['s1', new Set([DAY])]]));
    expect(tracker.filterDirty('s1', reports)).toEqual([
      { day: OTHER_DAY, minutes: encodeMinutes([2]) },
    ]);
  });

  it('markAllDirty re-marks everything ever observed, even already-clean days', () => {
    const tracker = new MinuteDirtyTracker();
    const reports = [{ day: DAY, minutes: encodeMinutes([1, 2]) }];
    tracker.observe('s1', reports);
    tracker.confirmSent(new Map([['s1', new Set([DAY])]]));
    expect(tracker.filterDirty('s1', reports)).toEqual([]);

    tracker.markAllDirty();
    expect(tracker.filterDirty('s1', reports)).toEqual(reports);
  });

  it('prune drops bookkeeping for sessions that are gone, so they start fresh if they return', () => {
    const tracker = new MinuteDirtyTracker();
    const reports = [{ day: DAY, minutes: encodeMinutes([1, 2]) }];
    tracker.observe('s1', reports);
    tracker.confirmSent(new Map([['s1', new Set([DAY])]]));
    expect(tracker.filterDirty('s1', reports)).toEqual([]);

    tracker.prune(new Set()); // s1 no longer live
    tracker.observe('s1', reports); // same session id reappears later
    expect(tracker.filterDirty('s1', reports)).toEqual(reports);
  });
});

describe('buildDirtySnapshot', () => {
  it('sends usage in full every cycle, unconditionally, even when nothing is dirty', () => {
    const tracker = new MinuteDirtyTracker();
    const full = session({
      tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      usage: [{ day: DAY, model: 'm', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }],
      activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }],
    });

    const first = buildDirtySnapshot([full], defaultVisibility, tracker);
    tracker.confirmSent(first.included);

    // Nothing changed since the first build — activeMinutes should now be
    // clean, but usage must still ride along in full.
    const second = buildDirtySnapshot([full], defaultVisibility, tracker);
    expect(second.sessions[0]?.usage).toEqual(full.usage);
    expect(second.sessions[0]?.tokens).toEqual(full.tokens);
    expect(second.sessions[0]?.activeMinutes).toBeUndefined();
  });

  it('omits activeMinutes entirely for a day with no new minutes', () => {
    const tracker = new MinuteDirtyTracker();
    const s = session({ activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }] });
    const first = buildDirtySnapshot([s], defaultVisibility, tracker);
    expect(first.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    tracker.confirmSent(first.included);

    const second = buildDirtySnapshot([s], defaultVisibility, tracker);
    expect(second.sessions[0]?.activeMinutes).toBeUndefined();
    expect(second.included.size).toBe(0);
  });

  it('includes only the day that actually changed when a session spans several days', () => {
    const tracker = new MinuteDirtyTracker();
    const s1 = session({
      activeMinutes: [
        { day: DAY, minutes: encodeMinutes([1]) },
        { day: OTHER_DAY, minutes: encodeMinutes([2]) },
      ],
    });
    const first = buildDirtySnapshot([s1], defaultVisibility, tracker);
    tracker.confirmSent(first.included);

    // DAY gained a new minute; OTHER_DAY is untouched.
    const s2 = session({
      activeMinutes: [
        { day: DAY, minutes: encodeMinutes([1, 5]) },
        { day: OTHER_DAY, minutes: encodeMinutes([2]) },
      ],
    });
    const second = buildDirtySnapshot([s2], defaultVisibility, tracker);
    expect(second.sessions[0]?.activeMinutes).toEqual([
      { day: DAY, minutes: encodeMinutes([1, 5]) },
    ]);
  });

  it('handles the real shape: tokens, usage and activeMinutes together on first sight', () => {
    const tracker = new MinuteDirtyTracker();
    const s = session({
      tokens: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
      usage: [
        { day: DAY, model: 'claude-fable-5', input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
      ],
      activeMinutes: [{ day: DAY, minutes: encodeMinutes([61, 62]) }],
    });
    const { sessions, included } = buildDirtySnapshot([s], defaultVisibility, tracker);
    expect(sessions[0]?.tokens).toEqual(s.tokens);
    expect(sessions[0]?.usage).toEqual(s.usage);
    expect(sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    expect(included.get('s1')).toEqual(new Set([DAY]));
  });

  it('a day with no new minutes across several sessions produces no included entries', () => {
    const tracker = new MinuteDirtyTracker();
    const a = session({ id: 'a', activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }] });
    const b = session({ id: 'b', activeMinutes: [{ day: DAY, minutes: encodeMinutes([9]) }] });
    const first = buildDirtySnapshot([a, b], defaultVisibility, tracker);
    tracker.confirmSent(first.included);

    const second = buildDirtySnapshot([a, b], defaultVisibility, tracker);
    expect(second.sessions.every((s) => s.activeMinutes === undefined)).toBe(true);
    expect(second.included.size).toBe(0);
  });

  it('hiding tokens withholds usage and activeMinutes from the wire, and does not mark them sent', () => {
    const tracker = new MinuteDirtyTracker();
    const s = session({
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      usage: [{ day: DAY, model: 'm', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }],
    });
    const hidden = { ...defaultVisibility, tokens: false };
    const first = buildDirtySnapshot([s], hidden, tracker);
    expect(first.sessions[0]?.tokens).toBeUndefined();
    expect(first.sessions[0]?.usage).toBeUndefined();
    expect(first.sessions[0]?.activeMinutes).toBeUndefined();
    expect(first.included.size).toBe(0);
    tracker.confirmSent(first.included);

    // Turning tokens back on later must still deliver the minutes that were
    // observed while hidden — they were never actually handed to a client,
    // so they must not have been marked clean.
    const second = buildDirtySnapshot([s], defaultVisibility, tracker);
    expect(second.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
  });
});

/**
 * A minimal fake `/ws/collector` endpoint: replies hello-ok to every hello
 * and queues every other message for `nextSnapshot` to consume, in order,
 * across reconnects.
 */
class FakeCollectorServer {
  readonly wss: WebSocketServer;
  readonly port: number;
  private sockets: WSSocket[] = [];
  private queue: CollectorSnapshot[] = [];
  private waiters: ((m: CollectorSnapshot) => void)[] = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello-ok',
              memberId: 'member-1',
              displayName: 'Tester',
              roomCode: 'ABCD-1234',
            }),
          );
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter(msg);
        else this.queue.push(msg);
      });
    });
    const addr = this.wss.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('server has no port');
    this.port = addr.port;
  }

  async nextSnapshot(timeoutMs = 4000): Promise<CollectorSnapshot> {
    const queued = this.queue.shift();
    if (queued) return queued;
    return new Promise<CollectorSnapshot>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for snapshot')),
        timeoutMs,
      );
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  /** Forcibly drops the oldest still-open connection, forcing the client to reconnect. */
  dropOldestConnection(): void {
    this.sockets.shift()?.terminate();
  }

  close(): void {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
  }
}

describe('reconnect resends dirty-cleared minutes', () => {
  it('re-sends the full minute set after a reconnect instead of skipping it as clean', async () => {
    const server = new FakeCollectorServer();
    const tracker = new MinuteDirtyTracker();
    const readyWaiters: (() => void)[] = [];
    let readyCount = 0;
    const waitForReady = () => new Promise<void>((resolve) => readyWaiters.push(resolve));

    const client = new CollectorClient({
      wsUrl: `ws://127.0.0.1:${server.port}`,
      deviceKey: 'x'.repeat(16),
      collectorVersion: 'test',
      log: () => {},
      onReady: () => {
        readyCount += 1;
        tracker.markAllDirty();
        readyWaiters.shift()?.();
      },
    });

    const s = session({ activeMinutes: [{ day: DAY, minutes: encodeMinutes([1, 2, 3]) }] });
    const send = () => {
      const { sessions, included } = buildDirtySnapshot([s], defaultVisibility, tracker);
      client.sendSnapshot({ type: 'snapshot', sessions, machine: {} }, () =>
        tracker.confirmSent(included),
      );
    };

    try {
      client.start();
      await waitForReady();
      expect(readyCount).toBe(1);

      send();
      const first = await server.nextSnapshot();
      expect(first.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);

      // Nothing changed; the minutes were already confirmed sent.
      send();
      const second = await server.nextSnapshot();
      expect(second.sessions[0]?.activeMinutes).toBeUndefined();

      server.dropOldestConnection();
      await waitForReady();
      expect(readyCount).toBe(2);

      // Reconnect re-marked everything dirty — the same, unchanged minutes
      // must go out again rather than being silently skipped as clean.
      send();
      const third = await server.nextSnapshot();
      expect(third.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    } finally {
      client.stop();
      server.close();
    }
  }, 10000);
});

/**
 * A minimal fake `CollectorSocket`: records every `send` call (payload plus
 * its completion callback) so a test can control exactly when — and whether
 * successfully — each write "completes", without a real network. Simulating
 * an actual failed write against a real `ws.Server` isn't practical (there's
 * no reliable way to make the library's own send-completion callback report
 * an error on demand), so this test drives `CollectorClient` directly at its
 * `createSocket` seam instead. What this does *not* prove: that a genuine OS-
 * level silent partition reliably surfaces through `ws`'s callback as an
 * error at all versus never calling back — only that *when* the callback
 * reports an error, this client correctly treats it as not-delivered.
 */
class FakeSocket {
  readyState = 1; // WebSocket.OPEN
  sends: { payload: string; cb?: (err?: Error) => void }[] = [];
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  send(payload: string, cb?: (err?: Error) => void): void {
    this.sends.push({ payload, cb });
  }

  close(): void {}

  asSocket(): CollectorSocket {
    return this as unknown as CollectorSocket;
  }
}

describe('a failed write does not clear the dirty flag', () => {
  it('leaves the day dirty on a send error, and the next successful send includes it', async () => {
    const fake = new FakeSocket();
    const tracker = new MinuteDirtyTracker();
    let readyResolve: (() => void) | undefined;
    const waitForReady = () =>
      new Promise<void>((resolve) => {
        readyResolve = resolve;
      });

    const client = new CollectorClient({
      wsUrl: 'ws://fake',
      deviceKey: 'x'.repeat(16),
      collectorVersion: 'test',
      log: () => {},
      onReady: () => readyResolve?.(),
      createSocket: () => fake.asSocket(),
    });

    const ready = waitForReady();
    client.start();
    fake.emit('open');
    fake.emit(
      'message',
      JSON.stringify({
        type: 'hello-ok',
        memberId: 'member-1',
        displayName: 'Tester',
        roomCode: 'ABCD-1234',
      }),
    );
    await ready;
    fake.sends = []; // drop the recorded hello; only snapshots matter below

    const s = session({ activeMinutes: [{ day: DAY, minutes: encodeMinutes([1, 2]) }] });
    const send = () => {
      const { sessions, included } = buildDirtySnapshot([s], defaultVisibility, tracker);
      client.sendSnapshot({ type: 'snapshot', sessions, machine: {} }, () =>
        tracker.confirmSent(included),
      );
    };

    send();
    expect(fake.sends).toHaveLength(1);
    const first = JSON.parse(fake.sends[0]?.payload ?? '{}') as CollectorSnapshot;
    expect(first.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    // Simulate a silent-partition write failure: `send` was called, but the
    // completion callback reports an error rather than success.
    fake.sends[0]?.cb?.(new Error('simulated write failure'));

    // The failed write must not have cleared the dirty flag — the next
    // build has to include the same day again.
    send();
    expect(fake.sends).toHaveLength(2);
    const second = JSON.parse(fake.sends[1]?.payload ?? '{}') as CollectorSnapshot;
    expect(second.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    // This time the write actually succeeds.
    fake.sends[1]?.cb?.();

    // Confirmed sent — a further build with nothing new must now be clean.
    send();
    expect(fake.sends).toHaveLength(3);
    const third = JSON.parse(fake.sends[2]?.payload ?? '{}') as CollectorSnapshot;
    expect(third.sessions[0]?.activeMinutes).toBeUndefined();

    client.stop();
  });
});

describe('a throwing onReady does not break the client', () => {
  it('does not propagate the exception out of hello-ok handling, so the reconnect backstop always runs', () => {
    const fake = new FakeSocket();
    const client = new CollectorClient({
      wsUrl: 'ws://fake',
      deviceKey: 'x'.repeat(16),
      collectorVersion: 'test',
      log: () => {},
      onReady: () => {
        throw new Error('boom');
      },
      createSocket: () => fake.asSocket(),
    });

    client.start();
    fake.emit('open');
    expect(() =>
      fake.emit(
        'message',
        JSON.stringify({
          type: 'hello-ok',
          memberId: 'member-1',
          displayName: 'Tester',
          roomCode: 'ABCD-1234',
        }),
      ),
    ).not.toThrow();

    client.stop();
  });
});
