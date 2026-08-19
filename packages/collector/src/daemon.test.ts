import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectorSnapshot, SessionSnapshot } from '@sloppers/protocol';
import { defaultVisibility, encodeMinutes } from '@sloppers/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WSSocket } from 'ws';
import type { PairingConfig } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import type { RoutableSession } from './core/types.js';
import {
  buildDirtySnapshot,
  buildPairingSnapshot,
  type Daemon,
  MinuteDirtyTracker,
  routeSessions,
  routingOrder,
  standDownDecision,
  startDaemon,
  unroutedSessions,
} from './daemon.js';
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

/** A complete pairing, for the tests that need more of one than `match`. */
function workspace(match: string[], overrides: Partial<PairingConfig> = {}): PairingConfig {
  return {
    server: { httpUrl: 'https://office.example', wsUrl: 'ws://office.example' },
    deviceKey: 'k'.repeat(32),
    memberId: 'm1',
    displayName: 'tester',
    roomCode: 'the-lab',
    match,
    visibility: { ...defaultVisibility },
    paused: false,
    ...overrides,
  };
}

function routable(snapshot: SessionSnapshot, cwd: string | undefined): RoutableSession {
  return { snapshot, cwd };
}

const pairing = (match: string[]) => ({ match }) as never;

describe('routeSessions', () => {
  it('sends each session to the first pairing that matches its cwd', () => {
    const work = pairing(['/work/**']);
    const home = pairing(['**']);
    const sessions = [
      { id: 's1', cwd: '/work/api' },
      { id: 's2', cwd: '/home/blog' },
    ] as never[];
    const routed = routeSessions(sessions, [work, home]);
    expect(routed.get(work)?.map((s) => s.id)).toEqual(['s1']);
    expect(routed.get(home)?.map((s) => s.id)).toEqual(['s2']);
  });

  it('reports a session matching nothing to nobody', () => {
    const work = pairing(['/work/**']);
    const routed = routeSessions([{ id: 's1', cwd: '/elsewhere' }] as never[], [work]);
    expect(routed.get(work)).toEqual([]);
  });

  it('keeps a pairing that claims nothing in the map, as an empty list', () => {
    // A pairing with no sessions still has to be *sent* an empty snapshot —
    // otherwise its office keeps showing whatever it last saw. So it must
    // appear in the routing table, not be omitted from it.
    const work = pairing(['/work/**']);
    const idle = pairing(['/never/**']);
    const routed = routeSessions([{ id: 's1', cwd: '/work/api' }] as never[], [work, idle]);
    expect(routed.has(idle)).toBe(true);
    expect(routed.get(idle)).toEqual([]);
  });

  it('follows the configured order, not pattern specificity: the earlier pairing wins', () => {
    // Both patterns match; nothing about `/work/api/**` being narrower earns
    // it the session. Swapping the two swaps the winner, and among pairings
    // that actually constrain a directory that is the whole rule.
    const outer = pairing(['/work/**']);
    const inner = pairing(['/work/api/**']);
    const sessions = [{ id: 's1', cwd: '/work/api/src' }] as never[];

    expect(
      routeSessions(sessions, [outer, inner])
        .get(outer)
        ?.map((s) => s.id),
    ).toEqual(['s1']);
    expect(routeSessions(sessions, [outer, inner]).get(inner)).toEqual([]);

    expect(
      routeSessions(sessions, [inner, outer])
        .get(inner)
        ?.map((s) => s.id),
    ).toEqual(['s1']);
    expect(routeSessions(sessions, [inner, outer]).get(outer)).toEqual([]);
  });

  it('does not let an inherited catch-all starve a newly added specific pairing', () => {
    // The shape every existing user hits on their very first attempt: a 0.1.1
    // config upgrades to one catch-all pairing, and `sloppers share` appends
    // the new one *after* it. Plain first-match-wins would hand every session
    // to the inherited `**` and leave the new office empty forever, fixable
    // only by hand-editing JSON. A catch-all claims everything, so it can
    // never be the more specific answer: it is a fallback, and sorts behind
    // anything that actually constrains a directory.
    const inherited = pairing(['**']);
    const added = pairing(['/work/**']);
    const sessions = [
      { id: 's1', cwd: '/work/api' },
      { id: 's2', cwd: '/personal/blog' },
    ] as never[];

    const routed = routeSessions(sessions, [inherited, added]);
    expect(routed.get(added)?.map((s) => s.id)).toEqual(['s1']);
    // And the catch-all still takes everything left over — it is demoted,
    // not disabled.
    expect(routed.get(inherited)?.map((s) => s.id)).toEqual(['s2']);
  });

  it('keeps two catch-alls in the order they were written', () => {
    const first = pairing(['**']);
    const second = pairing(['***']);
    const sessions = [{ id: 's1', cwd: '/anywhere' }] as never[];
    expect(
      routeSessions(sessions, [first, second])
        .get(first)
        ?.map((s) => s.id),
    ).toEqual(['s1']);
    expect(
      routeSessions(sessions, [second, first])
        .get(second)
        ?.map((s) => s.id),
    ).toEqual(['s1']);
  });

  it('routes a session whose cwd is unknown only to a catch-all pairing', () => {
    // A harness that never wrote a cwd still produced real spend, and under
    // 0.1.1 (one catch-all pairing) it was shared. That must not change.
    const catchAll = pairing(['**']);
    const scoped = pairing(['/work/**']);
    const sessions = [{ id: 's1' }] as never[];
    expect(
      routeSessions(sessions, [catchAll])
        .get(catchAll)
        ?.map((s) => s.id),
    ).toEqual(['s1']);
    expect(routeSessions(sessions, [scoped]).get(scoped)).toEqual([]);
  });

  it('preserves the order sessions arrived in within each pairing', () => {
    const home = pairing(['**']);
    const sessions = [
      { id: 's1', cwd: '/a' },
      { id: 's2', cwd: '/b' },
      { id: 's3', cwd: '/c' },
    ] as never[];
    expect(
      routeSessions(sessions, [home])
        .get(home)
        ?.map((s) => s.id),
    ).toEqual(['s1', 's2', 's3']);
  });
});

describe('routingOrder', () => {
  it('puts catch-alls behind every pairing that constrains a directory', () => {
    const catchAll = pairing(['**']);
    const work = pairing(['/work/**']);
    const personal = pairing(['/personal/**']);
    expect(routingOrder([catchAll, work, personal])).toEqual([work, personal, catchAll]);
  });

  it('is stable within each group, so config order still decides the rest', () => {
    const a = pairing(['/a/**']);
    const b = pairing(['/b/**']);
    const one = pairing(['**']);
    const two = pairing(['***']);
    expect(routingOrder([one, a, two, b])).toEqual([a, b, one, two]);
  });

  it('leaves a list with no catch-all exactly as it was', () => {
    const a = pairing(['/a/**']);
    const b = pairing(['~/**']);
    expect(routingOrder([a, b])).toEqual([a, b]);
    expect(routingOrder([])).toEqual([]);
  });
});

describe('unroutedSessions', () => {
  it('lists the sessions no pairing claims, so a bad pattern is discoverable', () => {
    // A session that matches nothing goes nowhere, which is correct — but it
    // also means its spend is silently invisible. `sloppers status` shows
    // these so someone whose tokens stopped counting can see why.
    const work = pairing(['/work/**']);
    const sessions = [
      { id: 's1', cwd: '/work/api' },
      { id: 's2', cwd: '/personal/blog' },
    ] as never[];
    expect(unroutedSessions(sessions, [work]).map((s) => s.id)).toEqual(['s2']);
  });

  it('is empty when some pairing is a catch-all', () => {
    const sessions = [{ id: 's1', cwd: '/anywhere' }] as never[];
    expect(unroutedSessions(sessions, [pairing(['/work/**']), pairing(['**'])])).toEqual([]);
  });
});

describe('buildPairingSnapshot', () => {
  it('never lets a cwd reach the wire — it is a local routing input only', () => {
    // Privacy, not tidiness: a full path leaks directory structure and very
    // often a person's name. `SessionSnapshot` carries `project` (a basename)
    // deliberately, and the cwd rides *outside* the snapshot so nothing that
    // builds an outgoing message can reach it by accident.
    const cwd = '/Users/ridham/work/acme-secret-client';
    const sessions = [routable(session({ project: 'acme-secret-client' }), cwd)];
    const { snapshot } = buildPairingSnapshot(
      workspace(['**']),
      sessions,
      new MinuteDirtyTracker(),
      { idleSeconds: 3 },
    );
    const wire = JSON.stringify(snapshot);
    expect(wire).not.toContain('cwd');
    expect(wire).not.toContain(cwd);
    expect(wire).not.toContain('/Users/ridham');
    // The basename still goes out — that is the field the office renders.
    expect(snapshot.sessions[0]?.project).toBe('acme-secret-client');
  });

  it('sends nothing at all for a paused pairing, not even machine telemetry', () => {
    const minutes = new MinuteDirtyTracker();
    const s = session({ activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }] });
    const { snapshot, included } = buildPairingSnapshot(
      workspace(['**'], { paused: true }),
      [routable(s, '/work/api')],
      minutes,
      { idleSeconds: 3 },
    );
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.machine).toEqual({});
    expect(included.size).toBe(0);
  });

  it('pausing one pairing does not stop another from sharing', () => {
    const minutes = new MinuteDirtyTracker();
    const s = session();
    const { snapshot } = buildPairingSnapshot(
      workspace(['**']),
      [routable(s, '/work/api')],
      minutes,
      {
        idleSeconds: 3,
      },
    );
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.machine).toEqual({ idleSeconds: 3 });
  });

  it('gives a session its whole minute history when it moves to another workspace', () => {
    // THE hazard of one-client-per-pairing. Dirty flags are per (session,
    // day) and clear once a snapshot is confirmed sent. Share a single
    // tracker across pairings and the first pairing's send marks the day
    // clean for everybody — so when the same session later routes somewhere
    // else (a narrowed pattern, a removed pairing, a reordered list, an
    // agent that cd'd out of the matched tree), the new workspace is never
    // told about that day at all. Minute bitmaps have no catch-up on the
    // server: an unreported day is simply absent, permanently.
    const from = workspace(['/work/**']);
    const to = workspace(['**']);
    const fromMinutes = new MinuteDirtyTracker();
    const toMinutes = new MinuteDirtyTracker();
    const s = session({ activeMinutes: [{ day: DAY, minutes: encodeMinutes([1, 2]) }] });

    const first = buildPairingSnapshot(from, [routable(s, '/work/api')], fromMinutes, {});
    expect(first.snapshot.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
    fromMinutes.confirmSent(first.included);

    // The session now routes to the other workspace, with nothing new to
    // report — same bitmap, same day.
    const second = buildPairingSnapshot(to, [routable(s, '/personal/blog')], toMinutes, {});
    expect(second.snapshot.sessions[0]?.activeMinutes).toEqual(s.activeMinutes);
  });

  it('a reconnect on one pairing does not disturb the other pairing’s bookkeeping', () => {
    // `markAllDirty` is the reconnect backstop, and a reconnect is a fact
    // about one connection. With a shared tracker it would re-mark every
    // other pairing's sessions too, so a client that never dropped resends
    // its whole minute history on the next heartbeat.
    const aMinutes = new MinuteDirtyTracker();
    const bMinutes = new MinuteDirtyTracker();
    const a = session({ id: 'a', activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }] });
    const b = session({ id: 'b', activeMinutes: [{ day: DAY, minutes: encodeMinutes([9]) }] });
    const workA = workspace(['/work/**']);
    const workB = workspace(['**']);

    aMinutes.confirmSent(
      buildPairingSnapshot(workA, [routable(a, '/work/api')], aMinutes, {}).included,
    );
    bMinutes.confirmSent(
      buildPairingSnapshot(workB, [routable(b, '/personal/blog')], bMinutes, {}).included,
    );

    // Only A's socket dropped and came back.
    aMinutes.markAllDirty();

    const resent = buildPairingSnapshot(workA, [routable(a, '/work/api')], aMinutes, {});
    expect(resent.snapshot.sessions[0]?.activeMinutes).toEqual(a.activeMinutes);
    const untouched = buildPairingSnapshot(workB, [routable(b, '/personal/blog')], bMinutes, {});
    expect(untouched.snapshot.sessions[0]?.activeMinutes).toBeUndefined();
  });

  it('delivers the same day’s minutes to two workspaces at once, one session each', () => {
    const aMinutes = new MinuteDirtyTracker();
    const bMinutes = new MinuteDirtyTracker();
    const a = session({ id: 'a', activeMinutes: [{ day: DAY, minutes: encodeMinutes([1]) }] });
    const b = session({ id: 'b', activeMinutes: [{ day: DAY, minutes: encodeMinutes([9]) }] });

    const first = buildPairingSnapshot(
      workspace(['/work/**']),
      [routable(a, '/work/api')],
      aMinutes,
      {},
    );
    aMinutes.confirmSent(first.included);
    const second = buildPairingSnapshot(
      workspace(['**']),
      [routable(b, '/personal/blog')],
      bMinutes,
      {},
    );
    bMinutes.confirmSent(second.included);

    expect(first.snapshot.sessions[0]?.activeMinutes).toEqual(a.activeMinutes);
    expect(second.snapshot.sessions[0]?.activeMinutes).toEqual(b.activeMinutes);
  });

  it('applies each pairing’s own visibility settings', () => {
    const s = session({
      title: 'secret',
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const open = buildPairingSnapshot(
      workspace(['**']),
      [routable(s, '/work/api')],
      new MinuteDirtyTracker(),
      {},
    );
    const shy = buildPairingSnapshot(
      workspace(['**'], { visibility: { ...defaultVisibility, title: false } }),
      [routable(s, '/work/api')],
      new MinuteDirtyTracker(),
      {},
    );
    expect(open.snapshot.sessions[0]?.title).toBe('secret');
    expect(shy.snapshot.sessions[0]?.title).toBeUndefined();
  });
});

describe('standDownDecision', () => {
  it('keeps the daemon up while any client is still serving a workspace', () => {
    expect(standDownDecision(['unknown-device', undefined])).toBeNull();
    expect(standDownDecision([undefined, undefined])).toBeNull();
  });

  it('stands down when there are no workspaces left at all', () => {
    // Not a rejection and not a takeover — the config simply has nothing in
    // it any more, which is the same state `startDaemon` refuses to start
    // into. A daemon left running here is connected to nothing and reporting
    // nothing, which is the hardest failure to spot from the outside.
    expect(standDownDecision([])).toBe('unpaired');
  });

  it('stands down clean only when every client was superseded', () => {
    // superseded means another machine took over: exit clean so the service
    // does NOT restart us. A rejected device key means re-pairing is needed:
    // exit non-zero so launchd/systemd bring us back. If the two disagree,
    // the restartable answer wins — coming back and finding the config fixed
    // is recoverable, staying down is not.
    expect(standDownDecision(['superseded'])).toBe('superseded');
    expect(standDownDecision(['superseded', 'superseded'])).toBe('superseded');
    expect(standDownDecision(['superseded', 'unknown-device'])).toBe('unknown-device');
    expect(standDownDecision(['unknown-device'])).toBe('unknown-device');
  });
});

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
  /** Every snapshot ever received, in arrival order. */
  readonly received: CollectorSnapshot[] = [];
  /** How many collectors have said hello here — one per pairing, not per daemon. */
  connections = 0;
  private sockets: WSSocket[] = [];
  private queue: CollectorSnapshot[] = [];
  private waiters: ((m: CollectorSnapshot) => void)[] = [];
  private matchers: {
    predicate: (m: CollectorSnapshot) => boolean;
    resolve: (m: CollectorSnapshot) => void;
  }[] = [];

  /**
   * Turns every hello into that error instead of a hello-ok. Mutable — not
   * just a constructor option — so a test can flip a server from healthy to
   * rejecting mid-flight and force a reconnect, simulating a pairing that
   * was fine and then got revoked (member deleted after the fact), rather
   * than one that was rejected from the very first hello.
   */
  rejectWith?: 'unknown-device' | 'superseded';

  constructor(rejectWith?: 'unknown-device' | 'superseded') {
    this.rejectWith = rejectWith;
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'hello') {
          this.connections += 1;
          ws.send(
            JSON.stringify(
              this.rejectWith
                ? { type: 'error', code: this.rejectWith, message: 'no' }
                : {
                    type: 'hello-ok',
                    memberId: 'member-1',
                    displayName: 'Tester',
                    roomCode: 'ABCD-1234',
                  },
            ),
          );
          return;
        }
        this.received.push(msg);
        for (const matcher of [...this.matchers]) {
          if (!matcher.predicate(msg)) continue;
          this.matchers = this.matchers.filter((m) => m !== matcher);
          matcher.resolve(msg);
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

  /** The first snapshot — already received or yet to arrive — matching `predicate`. */
  async waitFor(
    predicate: (m: CollectorSnapshot) => boolean,
    timeoutMs = 15_000,
  ): Promise<CollectorSnapshot> {
    const already = this.received.find(predicate);
    if (already) return already;
    return new Promise<CollectorSnapshot>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a matching snapshot')),
        timeoutMs,
      );
      this.matchers.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
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

/**
 * A synthetic Claude Code transcript under `home`, with one assistant turn
 * carrying usage — enough to produce a session with tokens and one active
 * minute. Returns the file path so a test can append to it.
 */
function writeClaudeSession(home: string, id: string, cwd: string): string {
  const dir = join(home, '.claude', 'projects', `-${id}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const at = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    {
      sessionId: id,
      cwd,
      isSidechain: false,
      timestamp: at,
      type: 'user',
      message: { content: 'go' },
    },
    {
      sessionId: id,
      cwd,
      isSidechain: false,
      timestamp: at,
      type: 'assistant',
      requestId: `${id}-req-1`,
      message: {
        model: 'claude-fable-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 100, output_tokens: 10 },
      },
    },
  ];
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return file;
}

/**
 * A `user` entry carrying a different cwd: it re-routes the session without
 * touching its minute bitmap (minutes are recorded only for assistant turns
 * with usage), which is exactly the case a shared dirty tracker loses.
 */
function appendCwdChange(file: string, id: string, cwd: string): void {
  appendFileSync(
    file,
    `${JSON.stringify({
      sessionId: id,
      cwd,
      isSidechain: false,
      timestamp: new Date().toISOString(),
      type: 'user',
      message: { content: 'moved' },
    })}\n`,
  );
}

/** Poll until `predicate` holds, or give up — for state with no event to await. */
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function pairingFor(port: number, match: string[], key: string): PairingConfig {
  return workspace(match, {
    server: { httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` },
    deviceKey: key.repeat(32).slice(0, 32),
    roomCode: `room-${key}`,
    displayName: `name-${key}`,
  });
}

describe('startDaemon runs one client per pairing', () => {
  let daemon: Daemon | null = null;
  const servers: FakeCollectorServer[] = [];

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    for (const s of servers.splice(0)) s.close();
  });

  it('routes each session by its directory, keeps cwd off the wire, and tracks dirty minutes per pairing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    const work = new FakeCollectorServer();
    const personal = new FakeCollectorServer();
    servers.push(work, personal);

    const workDir = join(home, 'work', 'api');
    const personalDir = join(home, 'personal', 'blog');
    const file = writeClaudeSession(home, 'moving-session', workDir);

    saveConfig(
      {
        version: 2,
        // Written in the order a real upgrade produces: the inherited
        // catch-all first, the workspace added later by `sloppers share
        // --match` after it. Plain first-match-wins would starve the new one.
        pairings: [
          pairingFor(personal.port, ['**'], 'b'),
          pairingFor(work.port, [join(home, 'work', '**')], 'a'),
        ],
      },
      home,
    );

    daemon = startDaemon({ collectorVersion: 'test', home, log: () => {} });

    // The specific pairing takes the session even though the catch-all is
    // listed above it, and the catch-all office is told it has nothing.
    const claimed = await work.waitFor((m) => m.sessions.length === 1);
    expect(claimed.sessions[0]?.project).toBe('api');
    expect(claimed.sessions[0]?.activeMinutes?.length).toBe(1);
    await personal.waitFor((m) => m.sessions.length === 0);

    // One client per pairing — two sockets, not one shared connection.
    expect(work.connections).toBe(1);
    expect(personal.connections).toBe(1);

    // Settle the dirty bookkeeping before the interesting part. Both clients
    // have now said hello, so both reconnect backstops (`markAllDirty`) have
    // already fired; this second send is the one that leaves the day
    // confirmed-clean for the work office with nothing left to re-mark it.
    // Without this step the outcome below would turn on which hello-ok
    // happened to land last, which is exactly the sort of ordering luck that
    // hides the bug rather than catching it.
    const settled = work.received.length;
    appendCwdChange(file, 'moving-session', workDir);
    await work.waitFor((m) => m.sessions.length === 1 && work.received.indexOf(m) >= settled);

    // Now the agent cd's out of the matched tree, and the session belongs to
    // the catch-all office instead. Its minutes did not change — a `user`
    // entry records none — so a *shared* dirty tracker calls that day clean
    // and the catch-all office is never told about it at all. Minute bitmaps
    // have no server-side catch-up: a day it never receives is simply absent
    // from it, permanently. Per-pairing trackers are what make this arrive.
    const seenByWork = work.received.length;
    appendCwdChange(file, 'moving-session', personalDir);
    const moved = await personal.waitFor((m) => m.sessions.length === 1);
    expect(moved.sessions[0]?.project).toBe('blog');
    expect(moved.sessions[0]?.activeMinutes?.length).toBe(1);
    // And the work office is told the session left, rather than keeping a
    // ghost of it on screen forever.
    await work.waitFor((m) => m.sessions.length === 0 && work.received.indexOf(m) >= seenByWork);

    // Privacy: no absolute path ever reached either office.
    const wire = JSON.stringify([...work.received, ...personal.received]);
    expect(wire).not.toContain('cwd');
    expect(wire).not.toContain(workDir);
    expect(wire).not.toContain(personalDir);
    expect(wire).not.toContain(home);
  }, 30_000);

  it('drops exactly the pairing the server rejected, keeps serving the other one through the real config watcher, and exits clean once none remain', async () => {
    // The whole point of dropping rather than restart-looping: one revoked
    // member must not take healthy workspaces down with it, and losing the
    // last one must not restart-loop either — it has to actually stop.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    const revoked = new FakeCollectorServer('unknown-device');
    const healthy = new FakeCollectorServer();
    servers.push(revoked, healthy);

    const revokedPairing = pairingFor(revoked.port, ['**'], 'a');
    const healthyPairing = pairingFor(healthy.port, ['**'], 'b');
    saveConfig({ version: 2, pairings: [revokedPairing, healthyPairing] }, home);

    const logged: string[] = [];
    let stoodDown: string | undefined;
    let standDownCalls = 0;
    daemon = startDaemon({
      collectorVersion: 'test',
      home,
      log: (m) => logged.push(m),
      onUnknownDevice: () => {
        stoodDown = 'unknown-device';
        standDownCalls += 1;
      },
      onSuperseded: () => {
        stoodDown = 'superseded';
        standDownCalls += 1;
      },
    });

    // The healthy workspace is serving, so the revoked one must not take the
    // whole daemon down with it.
    await healthy.waitFor(() => true);
    expect(stoodDown).toBeUndefined();

    // Nobody edited the config by hand — the rejected pairing disappears
    // from disk on its own, through the real config-file watcher, the exact
    // same loop `sloppers pause`/hide edits already ride.
    await waitUntil(() => (loadConfig(home)?.pairings.length ?? -1) === 1);
    expect(loadConfig(home)?.pairings.map((p) => p.deviceKey)).toEqual([healthyPairing.deviceKey]);
    expect(stoodDown).toBeUndefined();

    // The surviving pairing's own client is untouched by its sibling's
    // demise — proven by forcing a fresh reconnect on it and watching it
    // complete normally, rather than assuming.
    healthy.dropOldestConnection();
    await waitUntil(() => healthy.connections === 2);
    expect(stoodDown).toBeUndefined();

    // Now the last remaining pairing is rejected too (its member deleted
    // after the first one already was). Flip the server and force a fresh
    // hello so this reconnect is the one that gets rejected.
    healthy.rejectWith = 'unknown-device';
    healthy.dropOldestConnection();

    await waitUntil(() => stoodDown !== undefined);
    expect(stoodDown).toBe('unknown-device');
    // And it says why on the way out rather than exiting mutely.
    expect(logged.some((m) => m.includes('sloppers share'))).toBe(true);
    // Nothing is paired any more — the state a restart would find too, so
    // exiting clean (not restart-looping) is the only sane behaviour.
    expect(loadConfig(home)?.pairings).toEqual([]);

    // No double-handling: `saveConfig` touches the file more than once
    // (write, rename, chmod), so the watcher can fire more than once for a
    // single logical drop. Give any lingering callback a chance to run, and
    // confirm the daemon still only ever stood down once.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(standDownCalls).toBe(1);
  }, 30_000);

  it('does not drop a pairing on a raw connection close — only an authoritative rejection does', async () => {
    // Dropping is destructive and irreversible, so it must never fire on a
    // network hiccup: an ambiguous close carries no reason at all, and a
    // dropped wifi connection must not cost someone their pairing.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    const office = new FakeCollectorServer();
    servers.push(office);
    const solePairing = pairingFor(office.port, ['**'], 'a');
    saveConfig({ version: 2, pairings: [solePairing] }, home);

    let stoodDown: string | undefined;
    daemon = startDaemon({
      collectorVersion: 'test',
      home,
      log: () => {},
      onUnknownDevice: () => {
        stoodDown = 'unknown-device';
      },
      onSuperseded: () => {
        stoodDown = 'superseded';
      },
    });

    await office.waitFor(() => true);
    expect(loadConfig(home)?.pairings).toHaveLength(1);

    // Twice, to cover both "offline, nothing has happened yet" and
    // "mid reconnect-cycle" — neither is a rejection.
    office.dropOldestConnection();
    await waitUntil(() => office.connections === 2);
    expect(loadConfig(home)?.pairings.map((p) => p.deviceKey)).toEqual([solePairing.deviceKey]);
    expect(stoodDown).toBeUndefined();

    office.dropOldestConnection();
    await waitUntil(() => office.connections === 3);
    expect(loadConfig(home)?.pairings.map((p) => p.deviceKey)).toEqual([solePairing.deviceKey]);
    expect(stoodDown).toBeUndefined();
  }, 30_000);

  it('a rejection landing right as an unrelated config edit lands does not lose either change or wedge the daemon', async () => {
    // The interaction the config watcher creates: dropping a pairing is
    // itself a config write, so it can fire the same watcher a `sloppers
    // pause` run from another terminal moments earlier (or later) also
    // fires. Neither edit may clobber the other, and reconciling twice in
    // quick succession must not double-handle or wedge the survivor.
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    const dropped = new FakeCollectorServer();
    const kept = new FakeCollectorServer();
    servers.push(dropped, kept);

    const droppedPairing = pairingFor(dropped.port, ['**'], 'a');
    const keptPairing = pairingFor(kept.port, ['~/work/**'], 'b');
    saveConfig({ version: 2, pairings: [droppedPairing, keptPairing] }, home);

    let stoodDown: string | undefined;
    daemon = startDaemon({
      collectorVersion: 'test',
      home,
      log: () => {},
      onUnknownDevice: () => {
        stoodDown = 'unknown-device';
      },
      onSuperseded: () => {
        stoodDown = 'superseded';
      },
    });

    await dropped.waitFor(() => true);
    await kept.waitFor(() => true);

    // A view of the config from *before* the rejection, standing in for a
    // concurrent `sloppers pause` that read the file first and writes a
    // moment later — exactly the ordering that would clobber the drop if
    // the two edits were not both actually landing on disk.
    const before = loadConfig(home);
    if (!before) throw new Error('config missing in test setup');

    // Flip the doomed pairing's server to start rejecting and force a
    // reconnect, so the next hello is the one that gets rejected —
    // triggering `dropPairing` from inside the daemon's own handler.
    dropped.rejectWith = 'unknown-device';
    dropped.dropOldestConnection();

    // Race the unrelated edit against it, based on the pre-rejection view.
    saveConfig(
      {
        ...before,
        pairings: before.pairings.map((p) =>
          p.deviceKey === keptPairing.deviceKey ? { ...p, paused: true } : p,
        ),
      },
      home,
    );

    // Both edits must survive: the rejected pairing gone, the untouched one
    // paused.
    await waitUntil(() => {
      const config = loadConfig(home);
      return (
        config?.pairings.length === 1 &&
        config.pairings[0]?.deviceKey === keptPairing.deviceKey &&
        config.pairings[0]?.paused === true
      );
    });
    expect(stoodDown).toBeUndefined();

    // The kept pairing's client was reused and re-pointed, not torn down and
    // rebuilt, and it is not wedged: it still reconnects normally afterward.
    expect(kept.connections).toBe(1);
    kept.dropOldestConnection();
    await waitUntil(() => kept.connections === 2);
    expect(stoodDown).toBeUndefined();
  }, 30_000);

  it('stands down, and says so, when a config edit leaves no workspaces at all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    const office = new FakeCollectorServer();
    servers.push(office);
    saveConfig({ version: 2, pairings: [pairingFor(office.port, ['**'], 'a')] }, home);

    const logged: string[] = [];
    let stoodDown: string | undefined;
    daemon = startDaemon({
      collectorVersion: 'test',
      home,
      log: (m) => logged.push(m),
      onUnknownDevice: () => {
        stoodDown = 'unknown-device';
      },
      onSuperseded: () => {
        stoodDown = 'superseded';
      },
    });
    await office.waitFor(() => true);
    expect(stoodDown).toBeUndefined();

    saveConfig({ version: 2, pairings: [] }, home);
    await waitUntil(() => stoodDown !== undefined);
    // Nothing was revoked and nobody took over, so exit clean: a restart
    // would only rediscover that there is nothing to share.
    expect(stoodDown).toBe('superseded');
    expect(logged.some((m) => m.includes('no workspaces'))).toBe(true);
  }, 30_000);

  it('refuses to start when nothing is paired', () => {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-daemon-'));
    expect(() => startDaemon({ collectorVersion: 'test', home, log: () => {} })).toThrow(
      /Not paired/,
    );
    saveConfig({ version: 2, pairings: [] }, home);
    expect(() => startDaemon({ collectorVersion: 'test', home, log: () => {} })).toThrow(
      /Not paired/,
    );
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
