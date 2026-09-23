import { describe, expect, it } from 'vitest';
import {
  dailyStatsSchema,
  dayIn,
  dayOf,
  decodeMinutes,
  encodeMinutes,
  estimateCostUsd,
  isKnownTimeZone,
  MINUTES_PER_DAY,
  minuteOfDay,
  minuteOfDayIn,
  minuteReportSchema,
  PRICING,
  recentDays,
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

  it('the pricing table is filled and dated', () => {
    // Was asserted empty while the table was a stub. Now that it carries real
    // published prices, the guard flips: an empty or undated table would mean
    // every cost in the office silently renders as "unknown".
    expect(PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(PRICING.models).length).toBeGreaterThan(0);
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

  it('round-trips a floor beside an unknowable total', () => {
    // The wire shape of a mixed Codex day: no total, and a priced share that
    // is worth showing. Dropping the floor silently would put the day back to
    // "no est." with nothing to say it had been computed.
    const floored = {
      tokens,
      sessionsRun: 3,
      activeMinutes: 61,
      byModel: { 'gpt-5.6-sol': tokens, 'codex-auto-review': tokens },
      estimatedCostUsd: null,
      estimatedCostFloorUsd: 4.2,
    };
    expect(dailyStatsSchema.parse(floored)).toEqual(floored);
  });

  it('parses stats from a server too old to send a floor', () => {
    const parsed = dailyStatsSchema.parse({
      tokens,
      sessionsRun: 3,
      activeMinutes: 61,
      estimatedCostUsd: null,
    });
    expect(parsed.estimatedCostFloorUsd).toBeUndefined();
  });
});

describe('time helpers', () => {
  it('formats a local day and minute index', () => {
    const t = new Date(2026, 7, 19, 3, 25).getTime();
    expect(dayOf(t)).toBe('2026-08-19');
    expect(minuteOfDay(t)).toBe(3 * 60 + 25);
  });
});

/**
 * The office's side of the clock: one instant, and what day it is in each
 * place somebody might be sitting.
 *
 * 2026-08-19T20:30:00Z is chosen because it is the case the whole feature
 * exists for — three offices reading the same moment as three different dates,
 * and two of them not the server's.
 */
describe('dayIn', () => {
  const AT = Date.parse('2026-08-19T20:30:00Z');

  it('cuts the day in the zone it was asked about', () => {
    expect(dayIn(AT, 'UTC')).toBe('2026-08-19');
    // 02:00 the next morning in Kolkata...
    expect(dayIn(AT, 'Asia/Kolkata')).toBe('2026-08-20');
    // ...and still early afternoon in California.
    expect(dayIn(AT, 'America/Los_Angeles')).toBe('2026-08-19');
  });

  it('reads the boundary itself from the right side', () => {
    // One minute either side of midnight in Kolkata (18:29:59Z / 18:30:01Z).
    expect(dayIn(Date.parse('2026-08-19T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-08-19');
    expect(dayIn(Date.parse('2026-08-19T18:30:01Z'), 'Asia/Kolkata')).toBe('2026-08-20');
  });

  it('sorts as a calendar, which is what BETWEEN in the ledger relies on', () => {
    expect(dayIn(AT, 'UTC') < dayIn(AT, 'Asia/Kolkata')).toBe(true);
  });

  it('survives a DST transition without repeating or skipping a date', () => {
    // 2026-11-01 is the autumn fall-back in US zones: a 25-hour local day.
    const day = 'America/Los_Angeles';
    expect(dayIn(Date.parse('2026-11-01T07:30:00Z'), day)).toBe('2026-11-01'); // 00:30 PDT
    expect(dayIn(Date.parse('2026-11-01T09:30:00Z'), day)).toBe('2026-11-01'); // 01:30 PST
    expect(dayIn(Date.parse('2026-11-02T07:59:00Z'), day)).toBe('2026-11-01'); // 23:59 PST
    expect(dayIn(Date.parse('2026-11-02T08:01:00Z'), day)).toBe('2026-11-02');
  });

  it('throws on a zone nobody knows, which is why callers validate first', () => {
    expect(() => dayIn(AT, 'Mars/Olympus')).toThrow();
  });
});

describe('minuteOfDayIn', () => {
  it('reads the wall clock in the zone, not an offset from midnight', () => {
    const at = Date.parse('2026-08-19T20:30:00Z');
    expect(minuteOfDayIn(at, 'UTC')).toBe(20 * 60 + 30);
    expect(minuteOfDayIn(at, 'Asia/Kolkata')).toBe(2 * 60);
  });

  it('renders the first minute of the day as 0, not 1440', () => {
    expect(minuteOfDayIn(Date.parse('2026-08-19T18:30:30Z'), 'Asia/Kolkata')).toBe(0);
  });

  it('stays inside the day on the 25-hour one', () => {
    // 01:30 PST, an hour after the fall-back repeated it. An offset from
    // midnight would say 150; the clock on the wall says 90, and that is the
    // bit the bitmap has room for.
    expect(minuteOfDayIn(Date.parse('2026-11-01T09:30:00Z'), 'America/Los_Angeles')).toBe(90);
  });
});

describe('isKnownTimeZone', () => {
  it('takes what Intl takes, aliases included', () => {
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Asia/Kolkata')).toBe(true);
    expect(isKnownTimeZone('Asia/Calcutta')).toBe(true);
    expect(isKnownTimeZone('America/Los_Angeles')).toBe(true);
  });

  it('answers false rather than throwing, whatever arrives', () => {
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
    expect(isKnownTimeZone('../../etc/passwd')).toBe(false);
  });
});

describe('recentDays', () => {
  it('walks back from a day, newest first', () => {
    expect(recentDays('2026-09-04', 3)).toEqual(['2026-09-04', '2026-09-03', '2026-09-02']);
  });

  it('crosses months and years the way a calendar does', () => {
    expect(recentDays('2026-09-01', 2)).toEqual(['2026-09-01', '2026-08-31']);
    expect(recentDays('2026-01-01', 2)).toEqual(['2026-01-01', '2025-12-31']);
    // A leap day is a day; a week over one has seven distinct labels.
    expect(recentDays('2028-03-01', 2)).toEqual(['2028-03-01', '2028-02-29']);
  });

  it('never repeats or skips a day, whatever the machine’s clock does', () => {
    // The reason this is UTC arithmetic. A local `Date` stepped by 24h across
    // a DST transition lands on the same calendar date twice in autumn and
    // skips one in spring — which in a week strip is a bar drawn over its
    // neighbour, or a worked day with nowhere to go.
    const week = recentDays('2026-11-02', 7);
    expect(new Set(week).size).toBe(7);
    expect(week).toEqual([
      '2026-11-02',
      '2026-11-01',
      '2026-10-31',
      '2026-10-30',
      '2026-10-29',
      '2026-10-28',
      '2026-10-27',
    ]);
  });

  it('asks for nothing and gets nothing', () => {
    expect(recentDays('2026-09-04', 0)).toEqual([]);
    expect(recentDays('2026-09-04', -1)).toEqual([]);
  });

  it('refuses to invent labels for a day it cannot read', () => {
    // A run of `NaN-NaN-NaN` cells is worse than an empty strip: it looks like
    // data. Callers pass `dayOf`'s own output, so this is a guard, not a path.
    expect(recentDays('not-a-day', 3)).toEqual([]);
    expect(recentDays('', 3)).toEqual([]);
    expect(recentDays('2026-9-4', 3)).toEqual([]);
  });
});
