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
  opts: {
    /**
     * This is the one-off catch-up at startup rather than the periodic
     * rescan, so a root asking to reach further back than `seedWindowMs` gets
     * to. See `SessionRoot.catchUpWindowMs`.
     */
    catchUp?: boolean;
  } = {},
): boolean {
  // One basis for every root, so which files are in scope does not drift
  // across a walk that takes a while.
  const now = Date.now();
  let seeded = false;
  for (const adapter of adapters) {
    for (const root of adapter.roots()) {
      if (!existsSync(root.path)) continue;
      const windowMs =
        opts.catchUp && root.catchUpWindowMs !== undefined
          ? Math.max(seedWindowMs, root.catchUpWindowMs)
          : seedWindowMs;
      const cutoff = now - windowMs;
      for (const relative of walk(root.path)) {
        const filePath = join(root.path, relative);
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
  // Watch every root, including ones that don't exist yet — installing a
  // second harness mid-run should just start working. (Seeding filters for
  // existence itself.)
  const roots = adapters.flatMap((a) => a.roots()).map((r) => r.path);

  // The one-off catch-up, so a root that needs older files for correct
  // attribution gets them; the rescan below deliberately does not.
  if (seedTracker(adapters, tracker, opts.seedWindowMs, { catchUp: true })) onChange();

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

/**
 * Every path under `root`, in a fixed order.
 *
 * Sorted because `readdirSync` returns whatever the filesystem happened to
 * hand back, and seeding order is not merely cosmetic: cross-file attribution
 * (a Claude resume, a Codex fork) gives a copied entry to whichever file
 * reaches the adapter first. Codex lays its rollouts out as
 * `YYYY/MM/DD/rollout-<iso>-<id>.jsonl`, so sorting is chronological, and the
 * original reaches the tracker before anything that replays it. Replaying the
 * local corpus in this order books 19.5428B tokens against a ground truth of
 * 19.5429B; in the reverse order the same corpus books 21.1B.
 */
function walk(root: string): string[] {
  try {
    return readdirSync(root, { recursive: true, encoding: 'utf8' }).sort();
  } catch {
    return [];
  }
}
