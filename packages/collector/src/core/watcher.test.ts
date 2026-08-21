import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexAdapter } from '../adapters/codex.js';
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

/**
 * The whole Codex path over real directories: an archived root, a live fork
 * replaying it, seeded the way the daemon seeds. This is the shape the local
 * corpus could not test — a cold corpus has no live group, so the archived root
 * is reaped at the first projection and never describes anything.
 */
describe('a live Codex lineage rooted in an archived rollout', () => {
  const ROOT_ID = '019f0000-0000-7000-8000-0000000root';
  const FORK_ID = '01a00000-0000-7000-8000-0000000fork';

  const meta = (id: string, cwd: string, extra: object, iso: string) =>
    JSON.stringify({
      timestamp: iso,
      type: 'session_meta',
      payload: { id, cwd, git: { branch: 'main' }, ...extra },
    });

  const tokenLine = (input: number, iso: string) =>
    JSON.stringify({
      timestamp: iso,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
        },
      },
    });

  const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });

  function build() {
    const home = mkdtempSync(join(tmpdir(), 'sloppers-codex-'));
    const archived = join(home, '.codex', 'archived_sessions');
    const liveDir = join(home, '.codex', 'sessions', '2026', '08', '21');
    mkdirSync(archived, { recursive: true });
    mkdirSync(liveDir, { recursive: true });

    const old = new Date(Date.now() - 2 * DAY).toISOString();
    const recent = new Date(Date.now() - 60_000).toISOString();

    // The root: finished two days ago, in the directory it was started in.
    const rootFile = join(archived, `rollout-2026-08-19T00-00-00-${ROOT_ID}.jsonl`);
    writeFileSync(
      rootFile,
      `${[
        meta(ROOT_ID, '/work/old-project', { thread_source: 'user' }, old),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
        tokenLine(1000, old),
        event('task_complete'),
      ].join('\n')}\n`,
    );
    const twoDaysAgo = (Date.now() - 2 * DAY) / 1000;
    utimesSync(rootFile, twoDaysAgo, twoDaysAgo);

    // The fork: replays the root's history, then works on, right now.
    const forkFile = join(liveDir, `rollout-2026-08-21T00-00-00-${FORK_ID}.jsonl`);
    writeFileSync(
      forkFile,
      `${[
        meta(
          FORK_ID,
          '/work/new-project',
          { forked_from_id: ROOT_ID, thread_source: 'subagent' },
          recent,
        ),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
        tokenLine(1000, recent),
        tokenLine(1500, recent),
        event('task_started'),
      ].join('\n')}\n`,
    );

    const adapter = createCodexAdapter(home);
    const tracker = new SessionTracker([adapter]);
    seedTracker([adapter], tracker, DAY, { catchUp: true });
    return { rootFile, tracker };
  }

  it('shows one session, described by the fork and identified by the root', () => {
    const { rootFile, tracker } = build();
    // Two days old, so only the catch-up window reaches the root at all.
    expect(tracker.trackedFiles()).toContain(rootFile);

    const snaps = tracker.snapshot(Date.now());
    expect(snaps).toHaveLength(1);
    const snap = snaps[0];

    // Identity from the root, so the wire id is stable as forks come and go.
    expect(snap?.id?.startsWith(ROOT_ID)).toBe(true);
    // Described by the file actually being written.
    expect(snap?.state).toBe('working');
    expect(snap?.project).toBe('new-project');
    // The replayed 1000 is booked once across the lineage, not twice.
    expect(snap?.tokens?.input).toBe(1500);
  });

  it('does not inherit the frozen root’s state or directory', () => {
    // The regression this guards: the root's last event is `task_complete`, so
    // taking `state` from it reads `waiting` while the fork is mid-turn.
    const { tracker } = build();
    const snap = tracker.snapshot(Date.now())[0];
    expect(snap?.state).not.toBe('waiting');
    expect(snap?.project).not.toBe('old-project');
  });
});
