import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countMinutes, dayOf, decodeMinutes } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { EXPIRE_MS } from './state.js';
import { SessionTracker } from './tracker.js';
import type { HarnessAdapter } from './types.js';
import { addUsage, markMinute, newAccumulator } from './types.js';

const AT = Date.parse('2026-08-19T05:30:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A minimal line format: `<sessionId> <kind> [tokens] [dayOffset]`.
 * `kind` of `sub` marks the file usage-only (a subagent sidechain); `lineage`
 * marks it usage-only but displayable when nothing else in the lineage is
 * tracked (a Codex rollout naming an absent root); `final` ends the turn.
 * `dayOffset` shifts the entry that many whole days from `AT`, which is how a
 * test spans enough days to reach the bucket caps.
 */
function fakeAdapter(root: string): HarnessAdapter {
  return {
    id: 'fake-harness',
    roots: () => [{ path: root }],
    matches: (p) => p.startsWith(root) && p.endsWith('.log'),
    newAccumulator,
    ingestLine(line, acc) {
      const [id, kind, tokens, dayOffset] = line.split(' ');
      if (id) acc.sessionId = id;
      acc.cwd = '/home/dev/proj';
      if (kind === 'sub') acc.usageOnly = true;
      if (kind === 'lineage') {
        acc.usageOnly = true;
        acc.displayIfOrphaned = true;
      }
      if (kind === 'final') acc.lastEventKind = 'agent-final';
      else acc.lastEventKind = 'other';
      const ms = AT + (dayOffset ? Number(dayOffset) : 0) * DAY_MS;
      markMinute(acc, ms);
      if (tokens) {
        addUsage(acc, ms, 'fake-model', {
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

/**
 * The harness's own session id, recovered from the wire id. Every wire id is
 * `<sessionId>#<fingerprint of the file path>`, so the prefix is what the
 * adapter actually read out of the transcript.
 */
function baseId(id: string | undefined): string | undefined {
  return id?.split('#')[0];
}

/** Every input token the snapshot reports across its usage buckets. */
function bucketedInput(snap: { usage?: { input: number }[] } | undefined): number {
  return (snap?.usage ?? []).reduce((sum, b) => sum + b.input, 0);
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
    expect(baseId(snap?.id)).toBe('s1');
    expect(snap).toMatchObject({
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

  it('expires quiet files that are never displayed, not just displayed ones', () => {
    const { root, tracker } = setup();
    const shown = join(root, 'main.log');
    const hidden = join(root, 'sub.log');
    writeFileSync(shown, 's1 work 100\n');
    writeFileSync(hidden, 's2 sub 250\n');
    tracker.ingestFile(shown, 1000);
    tracker.ingestFile(hidden, 1000);
    expect(tracker.trackedFiles()).toHaveLength(2);

    // A usage-only entry never reaches the projection loop's body, so if
    // expiry were checked after the display filters it would be held — and
    // keep growing buckets and minute sets — for the life of the process.
    // Sidechains outnumber displayable sessions better than ten to one.
    tracker.snapshot(1000 + EXPIRE_MS);
    expect(tracker.trackedFiles()).toEqual([]);
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
    expect(snaps.map((s) => baseId(s.id))).toEqual(['s-new', 's-old']);
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

describe('SessionTracker grouping', () => {
  it('folds a sidechain file into its parent session instead of listing it', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    tracker.ingestFile(main, 5000);
    tracker.ingestFile(sub, 5000);

    const snaps = tracker.snapshot(6000);
    expect(snaps).toHaveLength(1);
    expect(baseId(snaps[0]?.id)).toBe('s-parent');
    // Display fields come from the parent, not the sidechain.
    expect(snaps[0]?.project).toBe('proj');
    expect(bucketedInput(snaps[0])).toBe(140);
    expect(snaps[0]?.tokens?.input).toBe(140);
  });

  it('sums a sidechain into its parent bucket when they share day and model', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    tracker.ingestFile(main, 5000);
    tracker.ingestFile(sub, 5000);

    const [snap] = tracker.snapshot(6000);
    expect(snap?.usage).toEqual([
      { day: dayOf(AT), model: 'fake-model', input: 140, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('does not double-count a folded sidechain across repeated snapshots', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    tracker.ingestFile(main, 5000);
    tracker.ingestFile(sub, 5000);

    // Merging must copy the adapters' buckets, never alias them: folding into
    // the parent's own map would compound the sidechain on every projection.
    expect(bucketedInput(tracker.snapshot(6000)[0])).toBe(140);
    expect(bucketedInput(tracker.snapshot(6001)[0])).toBe(140);
    expect(bucketedInput(tracker.snapshot(6002)[0])).toBe(140);
  });

  it('drops a sidechain whose parent session is gone rather than inventing one', () => {
    const { root, tracker } = setup();
    const sub = join(root, 'orphan-subagent.log');
    writeFileSync(sub, 's-orphan sub 40\n');
    tracker.ingestFile(sub, 5000);
    expect(tracker.snapshot(6000)).toHaveLength(0);
  });

  it("retains an orphaned sidechain's spend until its parent turns up", () => {
    const { root, tracker } = setup();
    const sub = join(root, 'orphan-subagent.log');
    const main = join(root, 'late-parent.log');
    writeFileSync(sub, 's-late sub 40\n');
    tracker.ingestFile(sub, 5000);
    expect(tracker.snapshot(6000)).toHaveLength(0);
    // Not displayed, but held: seedTracker walks in unsorted directory order,
    // so a sidechain can reach the tracker before the parent it belongs to.
    expect(tracker.trackedFiles()).toEqual([sub]);

    writeFileSync(main, 's-late work 100\n');
    tracker.ingestFile(main, 7000);
    const snaps = tracker.snapshot(8000);
    expect(snaps).toHaveLength(1);
    expect(bucketedInput(snaps[0])).toBe(140);
  });

  it('still reports a lineage whose root rollout is not tracked', () => {
    // Codex names a parent thread that may have been archived or fallen out of
    // the seed window. A Claude sidechain in that state stays hidden — its
    // parent is a live file that will turn up — but a Codex lineage's root may
    // never turn up at all, and holding its spend forever loses it.
    const { root, tracker } = setup();
    const a = join(root, 'b-second.log');
    const b = join(root, 'a-first.log');
    writeFileSync(a, 's-gone lineage 40\n');
    writeFileSync(b, 's-gone lineage 60\n');
    tracker.ingestFile(a, 5000);
    tracker.ingestFile(b, 6000);

    const snaps = tracker.snapshot(7000);
    // One session for the whole lineage, carrying every member's spend.
    expect(snaps).toHaveLength(1);
    expect(baseId(snaps[0]?.id)).toBe('s-gone');
    expect(bucketedInput(snaps[0])).toBe(100);
  });

  it('hands the lineage back to its root as soon as the root is tracked', () => {
    const { root, tracker } = setup();
    const sub = join(root, 'a-sub.log');
    const main = join(root, 'z-root.log');
    writeFileSync(sub, 's-late lineage 40\n');
    tracker.ingestFile(sub, 5000);
    expect(tracker.snapshot(6000)).toHaveLength(1);

    writeFileSync(main, 's-late work 100\n');
    tracker.ingestFile(main, 7000);
    const snaps = tracker.snapshot(8000);
    expect(snaps).toHaveLength(1);
    // The root displays even though its path sorts last: a real session always
    // beats a stand-in.
    expect(bucketedInput(snaps[0])).toBe(140);
    expect(snaps[0]?.id).not.toBe(undefined);
  });

  it('keeps an orphaned Claude sidechain hidden, as before', () => {
    // The new fallback is opt-in, so nothing changes for a harness that did
    // not ask for it.
    const { root, tracker } = setup();
    const sub = join(root, 'orphan-subagent.log');
    writeFileSync(sub, 's-orphan sub 40\n');
    tracker.ingestFile(sub, 5000);
    expect(tracker.snapshot(6000)).toHaveLength(0);
  });

  it('keeps two non-sidechain files that share a session id as two sessions', () => {
    const { root, tracker } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    // Codex reassigns sessionId on every session_meta and never sets
    // usageOnly, so distinct rollouts really do collide on an id: 7 ids span
    // more than one of the 494 local rollout files, one of them 29 files.
    // Grouping on the id alone would hide 92 of them.
    writeFileSync(a, 's-shared work 100\n');
    writeFileSync(b, 's-shared work 40\n');
    tracker.ingestFile(a, 5000);
    tracker.ingestFile(b, 6000);

    const snaps = tracker.snapshot(7000);
    expect(snaps).toHaveLength(2);
    expect(snaps.map((s) => s.tokens?.input).sort()).toEqual([100, 40].sort());
  });

  it('gives colliding sessions distinct ids so the ledger can tell them apart', () => {
    const { root, tracker } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    writeFileSync(a, 's-shared work 100\n');
    writeFileSync(b, 's-shared work 40\n');
    tracker.ingestFile(a, 5000);
    tracker.ingestFile(b, 6000);

    // `TokenLedger.ingest` keys its watermark on the snapshot id alone. Two
    // snapshots sharing one id inside a batch make the second restate the
    // first's watermark downwards, and the delta is re-banked on every cycle
    // forever — so distinct ids are what keeps the leaderboard finite.
    const snaps = tracker.snapshot(7000);
    const ids = snaps.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    // The harness's own id stays readable as the prefix, so a wire id can
    // still be traced back to the transcript it came from.
    expect(ids.every((id) => id.startsWith('s-shared#'))).toBe(true);
  });

  it("keeps a session's wire id when the session it collided with expires", () => {
    const { root, tracker } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    writeFileSync(a, 's-shared work 100\n');
    writeFileSync(b, 's-shared work 40\n');
    tracker.ingestFile(a, 1000);
    tracker.ingestFile(b, 1000);
    const contested = tracker.snapshot(2000).find((s) => s.tokens?.input === 40)?.id;
    expect(contested).toBeDefined();

    // `a` goes quiet and is reaped; `b` keeps working. If contention were
    // recomputed per batch, `b` would now look uncontested and quietly revert
    // to the bare id — landing on the ledger watermark row `a` already owns,
    // which loses tokens through the `shrank` branch and reopens the inflation
    // path if `a` ever resumes. A wire id has to be a property of the session,
    // not of whoever happens to be alive alongside it.
    appendFileSync(b, 's-shared work 40\n');
    const later = 1000 + EXPIRE_MS;
    tracker.ingestFile(b, later);
    const survivors = tracker.snapshot(later + 1000);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(contested);
  });

  it('gives a session the same wire id alone as alongside its contender', () => {
    const { root } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    writeFileSync(a, 's-shared work 100\n');
    writeFileSync(b, 's-shared work 40\n');

    const alone = new SessionTracker([fakeAdapter(root)]);
    alone.ingestFile(b, 6000);
    const soloId = alone.snapshot(7000)[0]?.id;

    const together = new SessionTracker([fakeAdapter(root)]);
    together.ingestFile(a, 5000);
    together.ingestFile(b, 6000);
    const pairedId = together.snapshot(7000).find((s) => s.tokens?.input === 40)?.id;

    expect(soloId).toBeDefined();
    expect(pairedId).toBe(soloId);
  });

  it('derives a colliding id from the file path, so it survives a restart', () => {
    const { root, tracker } = setup();
    const a = join(root, 'a.log');
    const b = join(root, 'b.log');
    writeFileSync(a, 's-shared work 100\n');
    writeFileSync(b, 's-shared work 40\n');
    tracker.ingestFile(a, 5000);
    tracker.ingestFile(b, 6000);
    const first = tracker.snapshot(7000).map((s) => s.id);

    // Same files, a brand new tracker, and the files ingested in the opposite
    // order: a restart must not rename a session, or every restart would
    // orphan its server-side watermark and re-bank the whole total.
    const restarted = new SessionTracker([fakeAdapter(root)]);
    restarted.ingestFile(b, 6000);
    restarted.ingestFile(a, 5000);
    const second = restarted.snapshot(7000).map((s) => s.id);
    expect(second.slice().sort()).toEqual(first.slice().sort());
  });

  it('keeps the harness session id as the prefix of every wire id', () => {
    const { root, tracker } = setup();
    const solo = join(root, 'solo.log');
    const other = join(root, 'other.log');
    writeFileSync(solo, 's1 work 100\n');
    writeFileSync(other, 's2 work 40\n');
    tracker.ingestFile(solo, 5000);
    tracker.ingestFile(other, 6000);
    const ids = tracker.snapshot(7000).map((s) => s.id);
    expect(ids.some((id) => id.startsWith('s1#'))).toBe(true);
    expect(ids.some((id) => id.startsWith('s2#'))).toBe(true);
  });

  it("does not change a parent's wire id when a sidechain joins its session", () => {
    const { root } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');

    const before = new SessionTracker([fakeAdapter(root)]);
    before.ingestFile(main, 5000);
    const withoutSub = before.snapshot(6000).map((s) => s.id);

    // A sidechain is folded, not displayed, so it must not perturb the id its
    // parent reports — the spend moves, the identity does not.
    const after = new SessionTracker([fakeAdapter(root)]);
    after.ingestFile(main, 5000);
    after.ingestFile(sub, 5000);
    const withSub = after.snapshot(6000).map((s) => s.id);

    expect(withSub).toHaveLength(1);
    expect(withSub).toEqual(withoutSub);
  });

  it('never emits two snapshots sharing an id, however many files collide', () => {
    const { root, tracker } = setup();
    for (let i = 0; i < 5; i++) {
      const file = join(root, `rollout-${i}.log`);
      writeFileSync(file, `s-shared work ${10 + i}\n`);
      tracker.ingestFile(file, 5000 + i);
    }
    const ids = tracker.snapshot(7000).map((s) => s.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('keeps a parent alive and working while its subagent is still writing', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    const parentAt = 1000;
    // A parent transcript is not appended to while a subagent runs — the tool
    // result only lands when the subagent finishes. 28 of 554 local sidechains
    // wrote while their parent had been quiet for over EXPIRE_MS, the worst by
    // 155 minutes, so per-entry expiry reaps the parent mid-task.
    const subAt = parentAt + EXPIRE_MS;
    tracker.ingestFile(main, parentAt);
    tracker.ingestFile(sub, subAt);

    const now = subAt + 1000;
    const snaps = tracker.snapshot(now);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.state).toBe('working');
    expect(snaps[0]?.lastActivityAt).toBe(subAt);
    expect(tracker.trackedFiles()).toHaveLength(2);
  });

  it('expires a whole group once its newest file goes quiet', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    tracker.ingestFile(main, 1000);
    tracker.ingestFile(sub, 2000);
    expect(tracker.snapshot(2000 + EXPIRE_MS)).toHaveLength(0);
    expect(tracker.trackedFiles()).toEqual([]);
  });

  it('caps the usage array without shrinking the flat token total', () => {
    const { root, tracker } = setup();
    const file = join(root, 'long.log');
    // 35 days, one bucket each: more than the wire's `usage` cap of 30.
    const days = 35;
    writeFileSync(file, Array.from({ length: days }, (_, i) => `s1 work 10 ${i}\n`).join(''));
    tracker.ingestFile(file, 5000);

    const [snap] = tracker.snapshot(6000);
    expect(snap?.usage).toHaveLength(30);
    // The cap is a wire-schema limit on the bucket array, not a decision to
    // forget spend: `tokens` is what the ledger banks and it stays complete.
    expect(snap?.tokens?.input).toBe(days * 10);
    const reported = new Set((snap?.usage ?? []).map((b) => b.day));
    expect(reported.has(dayOf(AT + (days - 1) * DAY_MS))).toBe(true);
    expect(reported.has(dayOf(AT))).toBe(false);
  });

  it('caps activeMinutes to the seven most recent days', () => {
    const { root, tracker } = setup();
    const file = join(root, 'long.log');
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => `s1 work 10 ${i}\n`).join(''));
    tracker.ingestFile(file, 5000);

    const [snap] = tracker.snapshot(6000);
    expect(snap?.activeMinutes?.map((m) => m.day)).toEqual(
      Array.from({ length: 7 }, (_, i) => dayOf(AT + (9 - i) * DAY_MS)),
    );
  });

  it('merges a sidechain and its parent into one day of active minutes', () => {
    const { root, tracker } = setup();
    const main = join(root, 'parent.log');
    const sub = join(root, 'parent-subagent.log');
    writeFileSync(main, 's-parent work 100\n');
    writeFileSync(sub, 's-parent sub 40\n');
    tracker.ingestFile(main, 5000);
    tracker.ingestFile(sub, 5000);

    const [snap] = tracker.snapshot(6000);
    expect(snap?.activeMinutes).toHaveLength(1);
    const bitmap = decodeMinutes(snap?.activeMinutes?.[0]?.minutes ?? '');
    expect(countMinutes(bitmap)).toBe(1);
    expect(snap?.activeMinutes?.[0]?.day).toBe(dayOf(AT));
  });
});
