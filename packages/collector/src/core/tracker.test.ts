import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPIRE_MS } from './state.js';
import { SessionTracker } from './tracker.js';
import type { HarnessAdapter } from './types.js';
import { addUsage, newAccumulator } from './types.js';

const AT = Date.parse('2026-08-19T05:30:00.000Z');

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
      if (kind === 'sub') acc.usageOnly = true;
      if (kind === 'final') acc.lastEventKind = 'agent-final';
      else acc.lastEventKind = 'other';
      if (tokens) {
        addUsage(acc, AT, 'fake-model', {
          input: Number(tokens),
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        });
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

  it('keeps reading usage-only files but never shows them as sessions', () => {
    const { root, tracker } = setup();
    const file = join(root, 'sub.log');
    writeFileSync(file, 's1 sub 250\n');
    // Still read — the spend is real and appears in no other transcript.
    expect(tracker.ingestFile(file, 5000)).toBe(true);
    expect(tracker.snapshot(6000)).toEqual([]);
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

  it('emits integer timestamps even from fractional file mtimes', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work\n');
    tracker.ingestFile(file, 5000.789);
    const [snap] = tracker.snapshot(6000);
    expect(Number.isInteger(snap?.startedAt)).toBe(true);
    expect(Number.isInteger(snap?.lastActivityAt)).toBe(true);
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

  it('exposes tracked paths for the polling fallback', () => {
    const { root, tracker } = setup();
    const file = join(root, 'a.log');
    writeFileSync(file, 's1 work\n');
    tracker.ingestFile(file, 1000);
    expect(tracker.trackedFiles()).toEqual([file]);
    // Re-ingesting via a poll picks up appended lines just like an event.
    appendFileSync(file, 's1 final\n');
    expect(tracker.ingestFile(file, 2000)).toBe(true);
    expect(tracker.snapshot(3000)[0]?.state).toBe('waiting');
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
