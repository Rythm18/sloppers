import { type FSWatcher as NodeFsWatcher, watch as watchFs } from 'node:fs';
import type {
  CollectorSnapshot,
  MinuteReport,
  SessionSnapshot,
  Visibility,
} from '@sloppers/protocol';
import { builtinAdapters } from './adapters/index.js';
import {
  type CollectorConfig,
  configDir,
  isCatchAll,
  loadConfig,
  matchesPairing,
  type PairingConfig,
} from './config.js';
import { machineIdleSeconds } from './core/idle.js';
import { SessionTracker } from './core/tracker.js';
import type { RoutableSession } from './core/types.js';
import { applyVisibility } from './core/visibility.js';
import { type WatchHandle, watchSessions } from './core/watcher.js';
import { CollectorClient } from './net/client.js';

const DEBOUNCE_MS = 1000;
const HEARTBEAT_MS = 30_000;
const IDLE_POLL_MS = 15_000;

export interface Daemon {
  stop(): Promise<void>;
}

/**
 * Which (session, day) minute bitmaps have changed since they were last
 * actually handed to a connected client. `usage` is deliberately not tracked
 * here at all — it always rides along in full (see `buildDirtySnapshot`),
 * because it is small and its per-bucket idempotence on the server is what
 * makes restarts and dropped sends safe. `activeMinutes` has no such
 * idempotent catch-up on the server (an unreported day is simply absent), so
 * skipping a day is only safe once we know it actually reached the wire.
 *
 * Clearing therefore happens on `confirmSent`, called only after a send has
 * actually been flushed to the socket — never at build time. A snapshot that
 * is merely *built* (and may never be sent, e.g. the collector is offline)
 * must not cause its minutes to be forgotten: the next build has to still
 * consider them dirty. `markAllDirty` is the reconnect backstop: a fresh
 * `hello-ok` means the server's own state is no longer something we can
 * trust our local bookkeeping about, so everything we know gets resent.
 */
export class MinuteDirtyTracker {
  private lastSeen = new Map<string, Map<string, string>>();
  private dirty = new Map<string, Set<string>>();

  /** Record a session's current minute bitmaps, marking any changed day dirty. */
  observe(sessionId: string, reports: readonly MinuteReport[]): void {
    let seen = this.lastSeen.get(sessionId);
    if (!seen) {
      seen = new Map();
      this.lastSeen.set(sessionId, seen);
    }
    for (const { day, minutes } of reports) {
      if (seen.get(day) !== minutes) {
        seen.set(day, minutes);
        this.markDirty(sessionId, day);
      }
    }
  }

  private markDirty(sessionId: string, day: string): void {
    let days = this.dirty.get(sessionId);
    if (!days) {
      days = new Set();
      this.dirty.set(sessionId, days);
    }
    days.add(day);
  }

  /** The subset of `reports` whose day is currently dirty for this session. */
  filterDirty(sessionId: string, reports: readonly MinuteReport[]): MinuteReport[] {
    const days = this.dirty.get(sessionId);
    if (!days || days.size === 0) return [];
    return reports.filter((r) => days.has(r.day));
  }

  /**
   * Clear dirty flags for exactly the (session, day) pairs a snapshot
   * actually carried onto the wire. Call only from a send's flush
   * confirmation, never at build time — see the class doc.
   */
  confirmSent(included: ReadonlyMap<string, ReadonlySet<string>>): void {
    for (const [sessionId, days] of included) {
      const set = this.dirty.get(sessionId);
      if (!set) continue;
      for (const day of days) set.delete(day);
      if (set.size === 0) this.dirty.delete(sessionId);
    }
  }

  /** Re-mark every day we have ever observed dirty — the reconnect backstop. */
  markAllDirty(): void {
    for (const [sessionId, days] of this.lastSeen) {
      for (const day of days.keys()) this.markDirty(sessionId, day);
    }
  }

  /** Drop bookkeeping for sessions no longer live, so it doesn't grow forever. */
  prune(liveSessionIds: ReadonlySet<string>): void {
    for (const id of this.lastSeen.keys()) {
      if (!liveSessionIds.has(id)) this.lastSeen.delete(id);
    }
    for (const id of this.dirty.keys()) {
      if (!liveSessionIds.has(id)) this.dirty.delete(id);
    }
  }
}

/**
 * Project raw tracker sessions onto the wire shape: dirty-filter each
 * session's `activeMinutes` down to days that changed since they were last
 * confirmed sent, then apply the owner's visibility settings. `usage` is
 * never filtered — it always passes through in full when `vis.tokens` allows
 * it at all.
 *
 * Returns `included`, the exact (session, day) pairs that made it onto the
 * wire in *this* payload — computed after visibility, since a day withheld
 * by a hidden `tokens` setting was not actually delivered and must not be
 * marked clean. The caller must feed this back into `MinuteDirtyTracker.
 * confirmSent` only once this exact payload is confirmed flushed to a
 * connected client.
 */
export function buildDirtySnapshot(
  sessions: readonly SessionSnapshot[],
  vis: Visibility,
  tracker: MinuteDirtyTracker,
): { sessions: SessionSnapshot[]; included: Map<string, Set<string>> } {
  const included = new Map<string, Set<string>>();
  const out = sessions.map((s) => {
    let candidate = s;
    if (s.activeMinutes) {
      tracker.observe(s.id, s.activeMinutes);
      const dirty = tracker.filterDirty(s.id, s.activeMinutes);
      if (dirty.length > 0) {
        candidate = { ...s, activeMinutes: dirty };
      } else {
        const { activeMinutes: _drop, ...rest } = s;
        candidate = rest;
      }
    }
    const visible = applyVisibility(candidate, vis);
    if (visible.activeMinutes && visible.activeMinutes.length > 0) {
      included.set(s.id, new Set(visible.activeMinutes.map((m) => m.day)));
    }
    return visible;
  });
  return { sessions: out, included };
}

/**
 * The order routing actually considers pairings in: the ones that constrain
 * a directory first, in config order, then the catch-alls, in config order.
 *
 * Without this, first-match-wins has a trap every existing user walks into on
 * their very first attempt. A `sloppers@0.1.1` config upgrades to exactly one
 * catch-all pairing, so the moment someone pairs a second office with
 * `~/work/**`, the inherited `**` sits above it and takes every session; the
 * new workspace connects, stays connected, and shows nothing forever. The
 * only remedy would be hand-editing JSON, for the most ordinary next step
 * there is.
 *
 * Demoting catch-alls costs nothing, because a pattern that matches
 * everything can never be the more specific answer: whatever it would have
 * won, it wins by claiming the whole filesystem, which is the definition of a
 * fallback. Among specific patterns the config order is still the whole rule
 * — nothing about one being narrower earns it a session — so a person can
 * still reason about their config top to bottom, with "catch-alls are the
 * fallback" as the single extra sentence.
 *
 * Partitioning rather than sorting, so the relative order inside each group
 * is preserved by construction: two catch-alls keep the order they were
 * written in, and so do two specific pairings.
 */
export function routingOrder(pairings: readonly PairingConfig[]): PairingConfig[] {
  return [
    ...pairings.filter((pairing) => !isCatchAll(pairing)),
    ...pairings.filter((pairing) => isCatchAll(pairing)),
  ];
}

/**
 * Which workspace each session belongs to: the first pairing in routing order
 * whose `match` globs contain its `cwd` takes it, and no other pairing sees
 * it. Every pairing gets an entry, including the ones that claimed nothing —
 * a workspace with no live sessions still has to be *sent* an empty snapshot
 * or its office keeps showing whatever it last saw.
 *
 * A session whose cwd is unknown is treated as the empty path, so only a
 * catch-all claims it. That is deliberately the 0.1.1 behaviour: the single
 * pairing an upgraded v1 config produces is a catch-all, so a session whose
 * harness never wrote a cwd keeps being shared exactly as before.
 *
 * Generic in the session type because routing only ever reads `cwd`: the
 * daemon passes `RoutableSession`s, and nothing here can see — let alone
 * forward — the wire snapshot they carry.
 */
export function routeSessions<T extends { cwd?: string | undefined }>(
  sessions: readonly T[],
  pairings: readonly PairingConfig[],
): Map<PairingConfig, T[]> {
  const routed = new Map<PairingConfig, T[]>();
  // Seeded in config order so the map reads the way the file does; the
  // ordered list below is what actually decides a winner.
  for (const pairing of pairings) routed.set(pairing, []);
  const ordered = routingOrder(pairings);
  for (const session of sessions) {
    const winner = ordered.find((pairing) => matchesPairing(pairing, session.cwd ?? ''));
    if (winner) routed.get(winner)?.push(session);
  }
  return routed;
}

/**
 * The sessions no pairing claims. Going nowhere is the correct answer for a
 * directory nobody paired, but it also means that session's spend is
 * silently invisible — nothing on the wire, nothing on any leaderboard, no
 * error anywhere. `sloppers status` prints these so a misconfigured pattern
 * is discoverable rather than mysterious.
 */
export function unroutedSessions<T extends { cwd?: string | undefined }>(
  sessions: readonly T[],
  pairings: readonly PairingConfig[],
): T[] {
  return sessions.filter(
    (session) => !pairings.some((pairing) => matchesPairing(pairing, session.cwd ?? '')),
  );
}

/**
 * One pairing's outgoing snapshot: its own sessions, its own visibility
 * settings, its own dirty-minute bookkeeping.
 *
 * `routed` carries each session's `cwd` alongside its wire snapshot, and
 * only the `snapshot` half is ever projected — the cwd is a local routing
 * input, never shared data.
 */
export function buildPairingSnapshot(
  pairing: PairingConfig,
  routed: readonly RoutableSession[],
  minutes: MinuteDirtyTracker,
  machine: CollectorSnapshot['machine'],
): { snapshot: CollectorSnapshot; included: Map<string, Set<string>> } {
  // Paused means paused: no sessions AND no machine telemetry — idle
  // seconds are at-the-keyboard presence data. Per pairing, so pausing one
  // workspace leaves the others sharing.
  if (pairing.paused) {
    return { snapshot: { type: 'snapshot', sessions: [], machine: {} }, included: new Map() };
  }
  const { sessions, included } = buildDirtySnapshot(
    routed.map((session) => session.snapshot),
    pairing.visibility,
    minutes,
  );
  return { snapshot: { type: 'snapshot', sessions, machine: { ...machine } }, included };
}

/** Why one pairing's client gave up; see `standDownDecision`. */
export type StandDownReason = 'unknown-device' | 'superseded';

/**
 * Whether the whole daemon should stand down, given why each pairing's
 * client stopped (`undefined` for one still serving).
 *
 * Both signals are per-connection — one office revoking a device key, or one
 * office handing this member to another machine, says nothing about the
 * others — so the daemon only exits once every workspace it has is gone. For
 * the single-pairing user that is exactly the previous behaviour: the one
 * client reports, the daemon stands down.
 *
 * When the reasons disagree, the restartable answer wins: `superseded` means
 * exit clean so the service does NOT restart us, and applying that while
 * another workspace merely needs re-pairing would leave the daemon down for
 * good instead of coming back to a fixed config.
 */
export function standDownDecision(
  reasons: readonly (StandDownReason | undefined)[],
): StandDownReason | null {
  if (reasons.length === 0) return null;
  if (reasons.some((reason) => reason === undefined)) return null;
  return reasons.every((reason) => reason === 'superseded') ? 'superseded' : 'unknown-device';
}

/** Everything the daemon holds for one pairing — one client, one workspace. */
interface PairingRuntime {
  pairing: PairingConfig;
  client: CollectorClient;
  /**
   * Per pairing, never shared. Dirty flags clear when a snapshot is confirmed
   * sent, so one shared tracker would let the first pairing's send mark a day
   * clean for every other pairing — and minute bitmaps have no catch-up on
   * the server, so a day another workspace never received is simply absent
   * from it, permanently.
   */
  minutes: MinuteDirtyTracker;
  standDown?: StandDownReason;
}

/**
 * The composed collector: adapters → tracker → routing → visibility filter →
 * one client per pairing, plus timers. Heartbeats double as state refreshers
 * — a session drifts working → waiting → idle purely with time, so the world
 * is re-derived and re-sent even without file events.
 *
 * The session tracker is shared (one machine, one set of transcripts);
 * everything downstream of routing is per pairing.
 */
export function startDaemon(opts: {
  collectorVersion: string;
  home?: string;
  log: (message: string) => void;
  /** Every workspace's device key was rejected; the daemon needs re-pairing. */
  onUnknownDevice?: () => void;
  /** Another machine took over every workspace; the daemon has stopped. */
  onSuperseded?: () => void;
}): Daemon {
  const initialConfig = loadConfig(opts.home);
  if (!initialConfig || initialConfig.pairings.length === 0) {
    throw new Error('Not paired yet — run `sloppers share <code>` first.');
  }

  const adapters = builtinAdapters(opts.home);
  const tracker = new SessionTracker(adapters);

  let idleSeconds: number | undefined;
  /** One runtime per pairing, in config order — routing reads that order. */
  let runtimes: PairingRuntime[] = [];

  const standDown = () => {
    const decision = standDownDecision(runtimes.map((runtime) => runtime.standDown));
    if (decision === 'superseded') opts.onSuperseded?.();
    else if (decision === 'unknown-device') opts.onUnknownDevice?.();
  };

  const createRuntime = (pairing: PairingConfig): PairingRuntime => {
    const minutes = new MinuteDirtyTracker();
    const runtime: PairingRuntime = {
      pairing,
      minutes,
      client: new CollectorClient({
        wsUrl: pairing.server.wsUrl,
        deviceKey: pairing.deviceKey,
        collectorVersion: opts.collectorVersion,
        log: opts.log,
        // A reconnect means this server's state is no longer something we can
        // trust our local "already sent" bookkeeping about — resend
        // everything we know, to this workspace only.
        onReady: () => minutes.markAllDirty(),
        onUnknownDevice: () => {
          runtime.standDown = 'unknown-device';
          standDown();
        },
        onSuperseded: () => {
          runtime.standDown = 'superseded';
          standDown();
        },
      }),
    };
    return runtime;
  };

  /**
   * Bring the running clients in line with `config`: keep (and re-point) the
   * ones still listed, start clients for pairings that appeared, stop the
   * ones that went away. A pairing is recognised across reloads by its device
   * key and server, so a `sloppers pause` or a visibility edit re-points the
   * existing client — and, crucially, keeps its dirty-minute bookkeeping —
   * rather than reconnecting and resending everything.
   */
  const reconcile = (config: CollectorConfig): void => {
    const spare = [...runtimes];
    const next: PairingRuntime[] = [];
    for (const pairing of config.pairings) {
      const held = spare.findIndex(
        (runtime) =>
          runtime.pairing.deviceKey === pairing.deviceKey &&
          runtime.pairing.server.wsUrl === pairing.server.wsUrl,
      );
      if (held >= 0) {
        const [reused] = spare.splice(held, 1);
        if (reused) {
          reused.pairing = pairing;
          next.push(reused);
          continue;
        }
      }
      const created = createRuntime(pairing);
      next.push(created);
      created.client.start();
    }
    for (const dropped of spare) dropped.client.stop();
    runtimes = next;
  };

  const send = () => {
    // The cwd is read here, before projection, and goes no further than the
    // routing decision: what each client is handed is the wire snapshot only.
    const routable = tracker.routableSnapshot(Date.now());
    const routed = routeSessions(
      routable,
      runtimes.map((runtime) => runtime.pairing),
    );
    const machine: CollectorSnapshot['machine'] = {};
    if (idleSeconds !== undefined) machine.idleSeconds = idleSeconds;
    // Pruned against every live session, not just this workspace's: a session
    // that merely moved to another pairing is still live, and forgetting it
    // here would resend its whole history if it ever came back.
    const live = new Set(routable.map((session) => session.snapshot.id));
    for (const runtime of runtimes) {
      const mine = routed.get(runtime.pairing) ?? [];
      const { snapshot, included } = buildPairingSnapshot(
        runtime.pairing,
        mine,
        runtime.minutes,
        machine,
      );
      runtime.minutes.prune(live);
      // Dirty flags clear only once this exact payload is actually flushed to
      // the wire — not here at build time. A snapshot built while offline (or
      // one that gets superseded before it flushes) must leave its minutes
      // dirty, or a failed send loses that day for good: activeMinutes has no
      // catch-up rule on the server, so an unreported day is just absent.
      runtime.client.sendSnapshot(snapshot, () => runtime.minutes.confirmSent(included));
    }
  };

  let debounce: NodeJS.Timeout | null = null;
  const sendSoon = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      send();
    }, DEBOUNCE_MS);
  };

  const watcher: WatchHandle = watchSessions({ adapters, tracker, onChange: sendSoon });

  const heartbeat = setInterval(send, HEARTBEAT_MS);
  const idlePoll = setInterval(() => {
    void machineIdleSeconds().then((s) => {
      idleSeconds = s;
    });
  }, IDLE_POLL_MS);
  void machineIdleSeconds().then((s) => {
    idleSeconds = s;
  });

  // Pick up `sloppers pause` / visibility edits, and whole workspaces added
  // or removed by `sloppers share`, without a restart.
  let configWatcher: NodeFsWatcher | null = null;
  try {
    configWatcher = watchFs(configDir(opts.home), (_event, filename) => {
      if (filename !== 'config.json') return;
      const next = loadConfig(opts.home);
      // Deleted or unparseable: keep running with the config we have rather
      // than tearing every workspace down over a half-written file.
      if (!next) return;
      reconcile(next);
      send();
    });
  } catch {
    // Config dir vanished; daemon keeps running with the loaded config.
  }

  reconcile(initialConfig);
  send();

  return {
    async stop() {
      if (debounce) clearTimeout(debounce);
      clearInterval(heartbeat);
      clearInterval(idlePoll);
      configWatcher?.close();
      await watcher.close();
      for (const runtime of runtimes) runtime.client.stop();
    },
  };
}
