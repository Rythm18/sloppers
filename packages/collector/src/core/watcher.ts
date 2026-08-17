import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { SessionTracker } from './tracker.js';
import type { HarnessAdapter } from './types.js';

const SEED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Re-stat every tracked file this often, catching dropped change events. */
const POLL_MS = 10_000;
/** Walk the roots for missed new files this often. */
const RESCAN_MS = 60_000;
const RESCAN_WINDOW_MS = 10 * 60 * 1000;

export interface WatchHandle {
  close(): Promise<void>;
}

/**
 * Wire filesystem events into the tracker. On start, session files touched
 * within the last day are folded in (establishing cumulative token counts);
 * after that only appended bytes are read, driven by fs events.
 */
/**
 * Catch up on sessions that were already live before we started: fold in
 * every matching file touched within the window. Returns true if anything
 * was ingested. Used by the watcher on start and by one-shot `status`.
 */
export function seedTracker(
  adapters: HarnessAdapter[],
  tracker: SessionTracker,
  seedWindowMs: number = SEED_WINDOW_MS,
): boolean {
  const roots = adapters.flatMap((a) => a.roots()).filter((r) => existsSync(r));
  const cutoff = Date.now() - seedWindowMs;
  let seeded = false;
  for (const root of roots) {
    for (const relative of walk(root)) {
      const filePath = join(root, relative);
      if (!tracker.adapterFor(filePath)) continue;
      try {
        const mtimeMs = statSync(filePath).mtimeMs;
        if (mtimeMs < cutoff) continue;
        if (tracker.ingestFile(filePath, mtimeMs)) seeded = true;
      } catch {
        // Raced a deletion; nothing to do.
      }
    }
  }
  return seeded;
}

export function watchSessions(opts: {
  adapters: HarnessAdapter[];
  tracker: SessionTracker;
  /** Called whenever the tracked world may have changed. */
  onChange: () => void;
  seedWindowMs?: number;
}): WatchHandle {
  const { adapters, tracker, onChange } = opts;
  const roots = adapters.flatMap((a) => a.roots()).filter((r) => existsSync(r));

  if (seedTracker(adapters, tracker, opts.seedWindowMs)) onChange();

  const watcher: FSWatcher = chokidar.watch(roots, {
    ignoreInitial: true,
    persistent: true,
  });
  const onFile = (filePath: string) => {
    let mtimeMs = Date.now();
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return;
    }
    if (tracker.ingestFile(filePath, mtimeMs)) onChange();
  };
  watcher.on('add', onFile);
  watcher.on('change', onFile);
  watcher.on('unlink', (filePath: string) => {
    tracker.removeFile(filePath);
    onChange();
  });

  // Filesystem events get dropped in the wild — during chokidar's initial
  // scan, across sleep/wake, under inotify pressure. A daemon that runs for
  // weeks needs a safety net: re-read tracked files often, rescan for files
  // we never got an "add" for occasionally.
  const pollTimer = setInterval(() => {
    let changed = false;
    for (const filePath of tracker.trackedFiles()) {
      try {
        if (tracker.ingestFile(filePath, statSync(filePath).mtimeMs)) changed = true;
      } catch {
        tracker.removeFile(filePath);
        changed = true;
      }
    }
    if (changed) onChange();
  }, POLL_MS);
  const rescanTimer = setInterval(() => {
    if (seedTracker(adapters, tracker, RESCAN_WINDOW_MS)) onChange();
  }, RESCAN_MS);

  return {
    close: () => {
      clearInterval(pollTimer);
      clearInterval(rescanTimer);
      return watcher.close();
    },
  };
}

function walk(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
}
