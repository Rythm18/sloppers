import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionTracker } from './tracker.js';
import type { HarnessAdapter, SessionRoot } from './types.js';
import { addUsage, newAccumulator } from './types.js';
import { seedTracker } from './watcher.js';

const DAY = 24 * 60 * 60 * 1000;

/** A file at `path` whose mtime is `ageDays` old. */
function write(path: string, ageDays: number): void {
  writeFileSync(path, 'x work 10\n');
  const when = (Date.now() - ageDays * DAY) / 1000;
  utimesSync(path, when, when);
}

/**
 * An adapter over two roots: `live` takes the caller's window, `deep` asks to
 * reach further back at startup. Mirrors the Codex sessions/archived split.
 */
function setup(deepCatchUpMs: number | undefined) {
  const base = mkdtempSync(join(tmpdir(), 'sloppers-seed-'));
  const live = join(base, 'live');
  const deep = join(base, 'deep');
  mkdirSync(live);
  mkdirSync(deep);
  const roots: SessionRoot[] = [{ path: deep, catchUpWindowMs: deepCatchUpMs }, { path: live }];
  const adapter: HarnessAdapter = {
    id: 'fake-harness',
    roots: () => roots.map((r) => ({ ...r })),
    matches: (p) => (p.startsWith(live) || p.startsWith(deep)) && p.endsWith('.log'),
    newAccumulator,
    ingestLine(line, acc) {
      const [id] = line.split(' ');
      if (id) acc.sessionId = id;
      acc.startedAtMs ??= 1000;
      addUsage(acc, Date.now(), 'm', { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
    },
  };
  return { live, deep, adapter, tracker: new SessionTracker([adapter]) };
}

describe('seedTracker root windows', () => {
  it('reaches a root past the caller window only when catching up', () => {
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    write(join(live, 'fresh.log'), 0);
    write(join(deep, 'old.log'), 2);

    // The rescan asks "what changed lately", so the two-day-old file in the
    // deep root stays out — otherwise every quiet file in it would be re-read
    // on every rescan, forever, once expiry had reaped it.
    seedTracker([adapter], tracker, 10 * 60 * 1000);
    expect(tracker.trackedFiles()).toEqual([join(live, 'fresh.log')]);
  });

  it('picks up the older file on the startup catch-up', () => {
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    write(join(live, 'fresh.log'), 0);
    write(join(deep, 'old.log'), 2);

    seedTracker([adapter], tracker, DAY, { catchUp: true });
    expect(tracker.trackedFiles().sort()).toEqual(
      [join(deep, 'old.log'), join(live, 'fresh.log')].sort(),
    );
  });

  it('still bounds the deep root — it is a window, not "everything"', () => {
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    write(join(live, 'fresh.log'), 0);
    write(join(deep, 'ancient.log'), 40);

    seedTracker([adapter], tracker, DAY, { catchUp: true });
    expect(tracker.trackedFiles()).toEqual([join(live, 'fresh.log')]);
  });

  it('leaves a root without its own window on the caller window', () => {
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    write(join(live, 'old.log'), 2);
    write(join(deep, 'old.log'), 2);

    seedTracker([adapter], tracker, DAY, { catchUp: true });
    // Only the deep root reaches back two days; the live root does not.
    expect(tracker.trackedFiles()).toEqual([join(deep, 'old.log')]);
  });

  it('treats the root window as a floor, never a ceiling', () => {
    const { deep, adapter, tracker } = setup(3 * DAY);
    write(join(deep, 'old.log'), 5);

    // A caller asking for more than the root does still gets it.
    seedTracker([adapter], tracker, 30 * DAY, { catchUp: true });
    expect(tracker.trackedFiles()).toEqual([join(deep, 'old.log')]);
  });

  it('seeds roots in the order the adapter lists them', () => {
    // Load-bearing for cross-file attribution: whichever file arrives first
    // owns the entries both of them report.
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    write(join(deep, 'a.log'), 0);
    write(join(live, 'a.log'), 0);

    seedTracker([adapter], tracker, DAY, { catchUp: true });
    expect(tracker.trackedFiles()[0]).toBe(join(deep, 'a.log'));
  });

  it('is unbothered by a root that does not exist', () => {
    // Codex users who have never archived a thread have no
    // `archived_sessions` directory at all.
    const { live, deep, adapter, tracker } = setup(3 * DAY);
    rmSync(deep, { recursive: true });
    write(join(live, 'fresh.log'), 0);
    expect(() => seedTracker([adapter], tracker, DAY, { catchUp: true })).not.toThrow();
    expect(tracker.trackedFiles()).toEqual([join(live, 'fresh.log')]);
  });
});
