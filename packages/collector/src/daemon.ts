import { type FSWatcher as NodeFsWatcher, watch as watchFs } from 'node:fs';
import type {
  CollectorSnapshot,
  MinuteReport,
  SessionSnapshot,
  Visibility,
} from '@sloppers/protocol';
import { builtinAdapters } from './adapters/index.js';
import { type CollectorConfig, configDir, loadConfig, type PairingConfig } from './config.js';
import { machineIdleSeconds } from './core/idle.js';
import { SessionTracker } from './core/tracker.js';
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
 * The pairing this daemon acts on. A config always has at least one
 * pairing once paired at all (an upgraded v1 file produces exactly one
 * catch-all pairing), so today's daemon simply runs the first one — this
 * is the single-workspace behavior unchanged from before v2. A later
 * task replaces this with real per-directory routing across every
 * pairing and one `CollectorClient` each.
 */
function firstPairing(config: CollectorConfig): PairingConfig | undefined {
  return config.pairings[0];
}

/**
 * The composed collector: adapters → tracker → visibility filter → client,
 * plus timers. Heartbeats double as state refreshers — a session drifts
 * working → waiting → idle purely with time, so the world is re-derived and
 * re-sent even without file events.
 */
export function startDaemon(opts: {
  collectorVersion: string;
  home?: string;
  log: (message: string) => void;
  /** Device key rejected; the daemon has stopped and needs re-pairing. */
  onUnknownDevice?: () => void;
  /** Another machine took over this member; the daemon has stopped. */
  onSuperseded?: () => void;
}): Daemon {
  const initialConfig = loadConfig(opts.home);
  const initialPairing = initialConfig && firstPairing(initialConfig);
  if (!initialPairing) {
    throw new Error('Not paired yet — run `sloppers share <code>` first.');
  }
  let pairing = initialPairing;

  const adapters = builtinAdapters(opts.home);
  const tracker = new SessionTracker(adapters);
  const minuteTracker = new MinuteDirtyTracker();
  const clientOptions: ConstructorParameters<typeof CollectorClient>[0] = {
    wsUrl: pairing.server.wsUrl,
    deviceKey: pairing.deviceKey,
    collectorVersion: opts.collectorVersion,
    log: opts.log,
    // A reconnect means the server's state is no longer something we can
    // trust our local "already sent" bookkeeping about — resend everything.
    onReady: () => minuteTracker.markAllDirty(),
  };
  if (opts.onUnknownDevice) clientOptions.onUnknownDevice = opts.onUnknownDevice;
  if (opts.onSuperseded) clientOptions.onSuperseded = opts.onSuperseded;
  const client = new CollectorClient(clientOptions);

  let idleSeconds: number | undefined;

  const buildSnapshot = (
    current: PairingConfig,
  ): { snapshot: CollectorSnapshot; included: Map<string, Set<string>> } => {
    // Paused means paused: no sessions AND no machine telemetry — idle
    // seconds are at-the-keyboard presence data.
    if (current.paused) {
      return { snapshot: { type: 'snapshot', sessions: [], machine: {} }, included: new Map() };
    }
    const machine: CollectorSnapshot['machine'] = {};
    if (idleSeconds !== undefined) machine.idleSeconds = idleSeconds;
    const raw = tracker.snapshot(Date.now());
    const { sessions, included } = buildDirtySnapshot(raw, current.visibility, minuteTracker);
    minuteTracker.prune(new Set(raw.map((s) => s.id)));
    return { snapshot: { type: 'snapshot', sessions, machine }, included };
  };

  const send = () => {
    const { snapshot, included } = buildSnapshot(pairing);
    // Dirty flags clear only once this exact payload is actually flushed to
    // the wire — not here at build time. A snapshot built while offline (or
    // one that gets superseded before it flushes) must leave its minutes
    // dirty, or a failed send loses that day for good: activeMinutes has no
    // catch-up rule on the server, so an unreported day is just absent.
    client.sendSnapshot(snapshot, () => minuteTracker.confirmSent(included));
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

  // Pick up `sloppers pause` / visibility edits without a restart.
  let configWatcher: NodeFsWatcher | null = null;
  try {
    configWatcher = watchFs(configDir(opts.home), (_event, filename) => {
      if (filename !== 'config.json') return;
      const next = loadConfig(opts.home);
      const nextPairing = next && firstPairing(next);
      if (nextPairing) {
        pairing = nextPairing;
        send();
      }
    });
  } catch {
    // Config dir vanished; daemon keeps running with the loaded config.
  }

  client.start();
  send();

  return {
    async stop() {
      if (debounce) clearTimeout(debounce);
      clearInterval(heartbeat);
      clearInterval(idlePoll);
      configWatcher?.close();
      await watcher.close();
      client.stop();
    },
  };
}
