import { type FSWatcher as NodeFsWatcher, watch as watchFs } from 'node:fs';
import type { CollectorSnapshot } from '@sloppers/protocol';
import { builtinAdapters } from './adapters/index.js';
import { type CollectorConfig, configDir, loadConfig } from './config.js';
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
  let config = loadConfig(opts.home);
  if (!config) {
    throw new Error('Not paired yet — run `sloppers share <code>` first.');
  }

  const adapters = builtinAdapters(opts.home);
  const tracker = new SessionTracker(adapters);
  const clientOptions: ConstructorParameters<typeof CollectorClient>[0] = {
    wsUrl: config.server.wsUrl,
    deviceKey: config.deviceKey,
    collectorVersion: opts.collectorVersion,
    log: opts.log,
  };
  if (opts.onUnknownDevice) clientOptions.onUnknownDevice = opts.onUnknownDevice;
  if (opts.onSuperseded) clientOptions.onSuperseded = opts.onSuperseded;
  const client = new CollectorClient(clientOptions);

  let idleSeconds: number | undefined;

  const buildSnapshot = (current: CollectorConfig): CollectorSnapshot => {
    // Paused means paused: no sessions AND no machine telemetry — idle
    // seconds are at-the-keyboard presence data.
    if (current.paused) return { type: 'snapshot', sessions: [], machine: {} };
    const machine: CollectorSnapshot['machine'] = {};
    if (idleSeconds !== undefined) machine.idleSeconds = idleSeconds;
    return {
      type: 'snapshot',
      sessions: tracker.snapshot(Date.now()).map((s) => applyVisibility(s, current.visibility)),
      machine,
    };
  };

  const send = () => {
    if (!config) return;
    client.sendSnapshot(buildSnapshot(config));
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
      if (next) {
        config = next;
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
