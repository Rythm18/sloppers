import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionTracker } from './tracker.js';
import { EXPIRE_MS } from './state.js';
import type { HarnessAdapter } from './types.js';
import { newAccumulator } from './types.js';

/** A minimal line format: `<sessionId> <kind> [tokens]` */
function fakeAdapter(root: string): HarnessAdapter {
  return {
    id: 'fake-harness',
    roots: () => [root],
    matches: (p) => p.startsWith(root) && p.endsWith('.log'),
    newAccumulator,
    ingestLine(line, acc) {
      const [id, kind, tokens] = line.split(' ');
      if (id) acc.sessionId = id;
      acc.cwd = '/home/dev/proj';
      if (kind === 'final') acc.lastEventKind = 'agent-final';
      else acc.lastEventKind = 'other';
      if (tokens) {
        acc.tokens = { input: Number(tokens), output: 0, cacheRead: 0, cacheWrite: 0 };
      }
      acc.startedAtMs ??= 1000;
    },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sloppers-tracker-'));
  const tracker = new SessionTracker([fakeAdapter(root)]);
  return { root, tracker };
}

describe('SessionTracker', () => {
  it('tracks a session from file events and projects a snapshot', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work 100\n');

    expect(tracker.ingestFile(file, 5000)).toBe(true);
    const [snap] = tracker.snapshot(6000);
    expect(snap).toMatchObject({
      id: 's1',
      harness: 'fake-harness',
      state: 'working',
      project: 'proj',
      tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      lastActivityAt: 5000,
    });
  });

  it('ignores files no adapter claims', () => {
    const { root, tracker } = setup();
    const file = join(root, 'notes.txt');
    writeFileSync(file, 'hello\n');
    expect(tracker.ingestFile(file, 1000)).toBe(false);
    expect(tracker.snapshot(2000)).toEqual([]);
  });

  it('only reports change when new lines actually arrived', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work\n');
    expect(tracker.ingestFile(file, 1000)).toBe(true);
    expect(tracker.ingestFile(file, 2000)).toBe(false);
    appendFileSync(file, 's1 final\n');
    expect(tracker.ingestFile(file, 3000)).toBe(true);
    expect(tracker.snapshot(4000)[0]?.state).toBe('waiting');
  });

  it('expires sessions that have been quiet too long', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work\n');
    tracker.ingestFile(file, 1000);
    expect(tracker.snapshot(2000)).toHaveLength(1);
    expect(tracker.snapshot(1000 + EXPIRE_MS)).toHaveLength(0);
    // ...and stays gone.
    expect(tracker.snapshot(1000 + EXPIRE_MS + 1)).toHaveLength(0);
  });

  it('sorts snapshots newest-activity first', () => {
    const { root, tracker } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    writeFileSync(a, 's-old work\n');
    writeFileSync(b, 's-new work\n');
    tracker.ingestFile(a, 1000);
    tracker.ingestFile(b, 9000);
    const snaps = tracker.snapshot(10000);
    expect(snaps.map((s) => s.id)).toEqual(['s-new', 's-old']);
  });

  it('drops entries whose files disappear', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work\n');
    tracker.ingestFile(file, 1000);
    // Simulate deletion between event and read by removing then re-ingesting.
    rmSync(file);
    expect(tracker.ingestFile(file, 2000)).toBe(false);
    expect(tracker.snapshot(3000)).toEqual([]);
  });
});
