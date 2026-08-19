import { describe, expect, it } from 'vitest';
import { createMessageLimiter, TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('allows a burst then refuses until refilled', () => {
    const bucket = new TokenBucket(10, 3);
    const t0 = 1_000_000;
    expect(bucket.take(t0)).toBe(true);
    expect(bucket.take(t0)).toBe(true);
    expect(bucket.take(t0)).toBe(true);
    expect(bucket.take(t0)).toBe(false);
    expect(bucket.take(t0 + 100)).toBe(true); // one token per 100ms at 10/s
  });

  it('does not mint free tokens when the clock steps backward then resumes', () => {
    const bucket = new TokenBucket(10, 3);
    const t0 = 1_000_000;
    expect(bucket.take(t0)).toBe(true);
    expect(bucket.take(t0)).toBe(true);
    expect(bucket.take(t0)).toBe(true); // burst spent, 0 tokens left
    // A backward clock step (e.g. an NTP correction) is correctly refused —
    // but must not retreat the bucket's notion of "last seen".
    expect(bucket.take(t0 - 500_000)).toBe(false);
    // 100ms after the *last legitimate* action earns exactly one token at
    // 10/s. If the backward call above had retreated the clock, this call
    // would instead see a bogus ~500,100ms gap and hand back the whole
    // burst (3 tokens) instead of the one the real elapsed time earned.
    expect(bucket.take(t0 + 100)).toBe(true); // the one token the real gap earned
    expect(bucket.take(t0 + 100)).toBe(false); // and nothing more than that
  });
});

describe('createMessageLimiter', () => {
  it('is generous with movement and strict with admin ops', () => {
    const limiter = createMessageLimiter();
    const t0 = 2_000_000;
    for (let i = 0; i < 40; i++) expect(limiter.allow('move', t0)).toBe(true);
    expect(limiter.allow('move', t0)).toBe(false);

    for (let i = 0; i < 15; i++) expect(limiter.allow('admin', t0)).toBe(true);
    expect(limiter.allow('admin', t0)).toBe(false);
  });

  it('governs activity and join with their own budgets', () => {
    const limiter = createMessageLimiter();
    const t0 = 4_000_000;
    for (let i = 0; i < 10; i++) expect(limiter.allow('activity', t0)).toBe(true);
    expect(limiter.allow('activity', t0)).toBe(false);

    for (let i = 0; i < 5; i++) expect(limiter.allow('join', t0)).toBe(true);
    expect(limiter.allow('join', t0)).toBe(false);
  });

  it('is not abusive until a bucket has been fully drained twice', () => {
    const limiter = createMessageLimiter();
    const t0 = 5_000_000;
    for (let i = 0; i < 10; i++) limiter.allow('activity', t0); // drains the burst
    expect(limiter.abusive()).toBe(false); // no refusal recorded yet
    expect(limiter.allow('activity', t0)).toBe(false); // first drain event
    expect(limiter.abusive()).toBe(false); // only one drain so far
  });

  it('flags abusive once a second drain lands within ten seconds of the first', () => {
    const limiter = createMessageLimiter();
    const t0 = 6_000_000;
    for (let i = 0; i < 10; i++) limiter.allow('activity', t0); // exhausts the burst
    expect(limiter.allow('activity', t0)).toBe(false); // drain #1
    expect(limiter.allow('activity', t0)).toBe(false); // drain #2, same instant
    expect(limiter.abusive()).toBe(true);
  });

  it('does not flag abusive when the two drains are more than ten seconds apart', () => {
    const limiter = createMessageLimiter();
    const t0 = 7_000_000;
    for (let i = 0; i < 5; i++) limiter.allow('join', t0); // exhausts the join burst
    expect(limiter.allow('join', t0)).toBe(false); // drain #1
    // 11s later the bucket has only trickled ~0.18 tokens back (1/min rate) —
    // still refused, but far enough from the first drain not to count.
    expect(limiter.allow('join', t0 + 11_000)).toBe(false); // drain #2, 11s later
    expect(limiter.abusive()).toBe(false);
  });

  it('does not let a backward clock step hide two drains that really landed close together', () => {
    const limiter = createMessageLimiter();
    const t0 = 9_000_000;
    for (let i = 0; i < 5; i++) limiter.allow('join', t0); // exhausts the join burst
    expect(limiter.allow('join', t0)).toBe(false); // drain #1, recorded at t0
    // A backward-stepped clock produces another refusal (still empty), but
    // if this retreated the recorded drain time, the *next* real drain would
    // compute its gap against that stale, earlier mark.
    expect(limiter.allow('join', t0 - 500_000)).toBe(false); // drain #2, bogus backward reading
    // In real wall-clock terms this lands 1ms after drain #1 — sustained
    // abuse, not a one-off. A retreated `latestDrainAt` would make the gap
    // look like ~500 seconds and hide it; the fix keeps the recorded clock
    // non-decreasing so it still reads as ~0-1ms.
    expect(limiter.allow('join', t0 + 1)).toBe(false); // drain #3, real time resumes
    expect(limiter.abusive()).toBe(true);
  });

  it('governs every kind in the client-to-server union', () => {
    const limiter = createMessageLimiter();
    const t0 = 8_000_000;
    for (const kind of ['join', 'move', 'activity', 'admin'] as const) {
      expect(limiter.allow(kind, t0)).toBe(true);
    }
  });
});
