import { describe, expect, it } from 'vitest';
import {
  dailyStatsSchema,
  dayOf,
  decodeMinutes,
  encodeMinutes,
  estimateCostUsd,
  MINUTES_PER_DAY,
  minuteOfDay,
  minuteReportSchema,
  PRICING,
  sessionSnapshotSchema,
  usageBucketSchema,
} from './index.js';

describe('usage buckets', () => {
  it('validates a bucket', () => {
    const bucket = {
      day: '2026-08-19',
      model: 'claude-opus-5',
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    };
    expect(usageBucketSchema.parse(bucket)).toEqual(bucket);
    expect(usageBucketSchema.safeParse({ ...bucket, day: '19-08-2026' }).success).toBe(false);
  });

  it('accepts a snapshot carrying only legacy tokens, and one carrying buckets', () => {
    const base = {
      id: 's1',
      harness: 'claude-code',
      state: 'working',
      startedAt: 1,
      lastActivityAt: 2,
    } as const;
    expect(
      sessionSnapshotSchema.safeParse({
        ...base,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      }).success,
    ).toBe(true);
    expect(
      sessionSnapshotSchema.safeParse({
        ...base,
        usage: [
          { day: '2026-08-19', model: 'x', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        ],
        activeMinutes: [{ day: '2026-08-19', minutes: 'AAAA' }],
      }).success,
    ).toBe(true);
  });

  it('round-trips usage and activeMinutes rather than silently dropping them', () => {
    // zod strips unrecognized keys by default, so a schema that dropped
    // `usage`/`activeMinutes` entirely would still report success on the
    // object above — only checking the parsed value proves they're kept.
    const withBuckets = {
      id: 's1',
      harness: 'claude-code',
      state: 'working',
      startedAt: 1,
      lastActivityAt: 2,
      usage: [{ day: '2026-08-19', model: 'x', input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
      activeMinutes: [{ day: '2026-08-19', minutes: 'AAAA' }],
    } as const;
    expect(sessionSnapshotSchema.parse(withBuckets)).toEqual(withBuckets);
  });
});

describe('minute reports', () => {
  it('rejects clearly non-base64 payloads', () => {
    expect(
      minuteReportSchema.safeParse({ day: '2026-08-19', minutes: 'not base64!! {}' }).success,
    ).toBe(false);
  });

  it('accepts an empty bitmap and a padded one', () => {
    expect(minuteReportSchema.safeParse({ day: '2026-08-19', minutes: '' }).success).toBe(true);
    expect(minuteReportSchema.safeParse({ day: '2026-08-19', minutes: 'AA==' }).success).toBe(true);
  });

  it('rejects a value over 300 chars', () => {
    expect(
      minuteReportSchema.safeParse({ day: '2026-08-19', minutes: 'A'.repeat(301) }).success,
    ).toBe(false);
  });
});

describe('minute bitmap encoding', () => {
  it('round-trips a set of minutes through base64 without Buffer', () => {
    const minutes = [0, 1, 7, 8, 60, 719, 1439];
    const encoded = encodeMinutes(minutes);
    const decoded = decodeMinutes(encoded);
    expect(decoded.length).toBe(MINUTES_PER_DAY / 8);
    for (const m of minutes) {
      const byte = decoded[m >> 3] ?? 0;
      expect((byte & (1 << (m & 7))) !== 0).toBe(true);
    }
    // Nothing else should be set.
    let total = 0;
    for (const byte of decoded) {
      let b = byte;
      while (b) {
        total += b & 1;
        b >>= 1;
      }
    }
    expect(total).toBe(minutes.length);
  });

  it('round-trips a full day of minutes (every bit set)', () => {
    const all = Array.from({ length: MINUTES_PER_DAY }, (_, i) => i);
    const encoded = encodeMinutes(all);
    const decoded = decodeMinutes(encoded);
    expect(decoded.every((byte) => byte === 0xff)).toBe(true);
  });

  it('encodes an empty set as an all-zero, full-length bitmap', () => {
    const decoded = decodeMinutes(encodeMinutes([]));
    expect(decoded.length).toBe(MINUTES_PER_DAY / 8);
    expect(decoded.every((byte) => byte === 0)).toBe(true);
  });

  it('never throws on a too-short input', () => {
    expect(() => decodeMinutes('')).not.toThrow();
    expect(() => decodeMinutes('AA')).not.toThrow();
    const decoded = decodeMinutes('AA');
    expect(decoded.length).toBe(MINUTES_PER_DAY / 8);
  });

  it('never throws or reads out of bounds on an oversized input', () => {
    const huge = 'A'.repeat(10_000);
    expect(() => decodeMinutes(huge)).not.toThrow();
    const decoded = decodeMinutes(huge);
    expect(decoded.length).toBe(MINUTES_PER_DAY / 8);
  });

  it('never throws on garbage, non-base64 input', () => {
    expect(() => decodeMinutes('not base64 at all!! {}[]')).not.toThrow();
    const decoded = decodeMinutes('not base64 at all!! {}[]');
    expect(decoded.length).toBe(MINUTES_PER_DAY / 8);
  });
});

describe('cost', () => {
  it('returns null for a model we have no price for, never zero', () => {
    expect(
      estimateCostUsd('some-model-we-never-heard-of', {
        input: 1000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    ).toBeNull();
  });

  it('the pricing table is the deliberately-empty stub for this task', () => {
    expect(PRICING.asOf).toBe('');
    expect(Object.keys(PRICING.models)).toHaveLength(0);
  });

  it('a model priced at zero is never confused with a model that has no price', () => {
    // PRICING.models is intentionally empty in this task (filled by Task 17
    // from official docs). To prove the branch that distinguishes "no entry"
    // from "entry priced at zero" actually works, inject a temporary
    // zero-priced entry and remove it again once the assertion is made.
    const models = PRICING.models as Record<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >;
    models['test-only-free-model'] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      expect(
        estimateCostUsd('test-only-free-model', {
          input: 1000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ).toBe(0);
      expect(
        estimateCostUsd('still-unknown-model', {
          input: 1000,
          output: 1000,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      ).toBeNull();
    } finally {
      delete models['test-only-free-model'];
    }
  });
});

describe('daily stats', () => {
  const tokens = { input: 5000, output: 800, cacheRead: 90000, cacheWrite: 0 };

  it('parses legacy stats with no byModel or estimatedCostUsd (old server/collector wire shape)', () => {
    expect(dailyStatsSchema.safeParse({ tokens, sessionsRun: 3, activeMinutes: 61 }).success).toBe(
      true,
    );
  });

  it('round-trips a per-model breakdown and a cost, including a null cost', () => {
    // Uses .parse() + toEqual rather than .safeParse().success: zod strips
    // unrecognized keys by default, so a schema that silently dropped
    // byModel/estimatedCostUsd would still report success — only checking
    // the parsed value round-trips the fields actually catches that.
    const withCost = {
      tokens,
      sessionsRun: 3,
      activeMinutes: 61,
      byModel: { 'claude-opus-5': tokens },
      estimatedCostUsd: 4.2,
    };
    expect(dailyStatsSchema.parse(withCost)).toEqual(withCost);

    const withNullCost = { ...withCost, estimatedCostUsd: null };
    expect(dailyStatsSchema.parse(withNullCost)).toEqual(withNullCost);
  });
});

describe('time helpers', () => {
  it('formats a local day and minute index', () => {
    const t = new Date(2026, 7, 19, 3, 25).getTime();
    expect(dayOf(t)).toBe('2026-08-19');
    expect(minuteOfDay(t)).toBe(3 * 60 + 25);
  });
});
