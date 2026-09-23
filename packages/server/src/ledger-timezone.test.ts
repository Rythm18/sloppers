import type { SessionSnapshot, UsageBucket } from '@sloppers/protocol';
import { encodeMinutes } from '@sloppers/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db/index.js';
import { TokenLedger } from './ledger.js';

/**
 * Which day an office is in, and what that costs the people in it.
 *
 * Separate from `ledger.test.ts` because everything here is about one
 * argument — the office's timezone — rather than about the banking arithmetic,
 * which is the same whatever the clock says. Every instant below is written as
 * a UTC timestamp on purpose: a test whose expectations depend on the machine
 * it runs on is a test about the machine.
 *
 * The moment almost every case uses is `2026-08-19T20:30:00Z`. It is the whole
 * problem in one instant: half past eight in the evening for a UTC office,
 * half past one in the afternoon in California, and two o'clock *the next
 * morning* in Kolkata.
 */
const EVENING_UTC = Date.parse('2026-08-19T20:30:00Z');
const UTC_DAY = '2026-08-19';
const KOLKATA_DAY = '2026-08-20';

const KOLKATA = 'Asia/Kolkata';
const CALIFORNIA = 'America/Los_Angeles';

function bucket(day: string, input: number, model = 'claude-fable-5'): UsageBucket {
  return { day, model, input, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function bucketed(id: string, usage: UsageBucket[], startedAt: number): SessionSnapshot {
  return {
    id,
    harness: 'claude-code',
    state: 'working',
    usage,
    startedAt,
    lastActivityAt: startedAt,
  };
}

/** A pre-0.2 collector: one cumulative total, no day of its own to offer. */
function flat(id: string, input: number, startedAt: number): SessionSnapshot {
  return {
    id,
    harness: 'claude-code',
    state: 'working',
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    startedAt,
    lastActivityAt: startedAt,
  };
}

describe('the day an office is in', () => {
  let db: Db;
  let ledger: TokenLedger;

  beforeEach(() => {
    db = openDb(':memory:');
    ledger = new TokenLedger(db);
  });

  /**
   * The promise the default makes. Every office in production predates this
   * field, and its rows have no `timezone` key — so the absent value has to
   * land on the clock the server was already cutting days on, which is UTC.
   *
   * Asserted against a *named* UTC office rather than against `dayOf`, so the
   * case means the same thing on a laptop in Kolkata as it does in the
   * container: serving the machine's own day instead of the office's is what
   * this is here to catch.
   */
  it('serves the UTC day when nobody has chosen one', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(UTC_DAY, 100)], EVENING_UTC)], EVENING_UTC);

    expect(ledger.todayFor('m1', EVENING_UTC).tokens.input).toBe(100);
    expect(ledger.todayFor('m1', EVENING_UTC)).toEqual(ledger.todayFor('m1', EVENING_UTC, 'UTC'));
    expect(ledger.todayFor('m1', EVENING_UTC)).toEqual(ledger.dayFor('m1', UTC_DAY));
  });

  /**
   * The same instant, the same rows, two offices — and two different answers
   * to "what is today". This is the case the whole feature is for, and it is
   * also the mutation gate: a server that answers with its own clock gives one
   * of these two the wrong day, whatever machine it is running on.
   */
  it('cuts today in the office’s zone, not the server’s', () => {
    // The member worked on both sides of the boundary: their Kolkata calendar
    // rolled over at 18:30Z while the UTC office was still on the 19th.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(UTC_DAY, 300), bucket(KOLKATA_DAY, 40)], EVENING_UTC)],
      EVENING_UTC,
      KOLKATA,
    );

    expect(ledger.todayFor('m1', EVENING_UTC, 'UTC').tokens.input).toBe(300);
    expect(ledger.todayFor('m1', EVENING_UTC, KOLKATA).tokens.input).toBe(40);
    expect(ledger.todayFor('m1', EVENING_UTC, CALIFORNIA).tokens.input).toBe(300);
  });

  /**
   * A Kolkata office at two in the morning is the west-of-UTC complaint in
   * reverse, and the one this fixes outright: their evening's work is on the
   * board under "today" instead of banked against a date the office had
   * already closed.
   */
  it('keeps a Kolkata office on its own date past midnight', () => {
    const lateNight = Date.parse('2026-08-19T20:30:00Z'); // 02:00 IST on the 20th
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(KOLKATA_DAY, 900)], lateNight)],
      lateNight,
      KOLKATA,
    );

    const today = ledger.todayFor('m1', lateNight, KOLKATA);
    expect(today.tokens.input).toBe(900);
    // ...and the office's history counts back from the same date, so the day
    // switch's "Today" and "Yesterday" are two consecutive Kolkata days.
    const week = ledger.recentFor('m1', TokenLedger.dayIn(lateNight, KOLKATA), 2);
    expect(week.map((d) => d.day)).toEqual([KOLKATA_DAY, UTC_DAY]);
  });

  /**
   * An owner moving the office's clock at lunchtime is a change of window, not
   * of data. Nothing is rewritten, nothing is lost, and the day that was being
   * served a moment ago is still there to be asked for by name.
   */
  it('loses nothing when the zone changes mid-day', () => {
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(UTC_DAY, 500), bucket(KOLKATA_DAY, 70)], EVENING_UTC)],
      EVENING_UTC,
      'UTC',
    );
    const before = ledger.todayFor('m1', EVENING_UTC, 'UTC');

    // The owner switches to Kolkata. The board re-reads and lands on a
    // different day; the old one is unchanged underneath it.
    expect(ledger.todayFor('m1', EVENING_UTC, KOLKATA).tokens.input).toBe(70);
    expect(ledger.dayFor('m1', UTC_DAY)).toEqual(before);
    // And back again, byte for byte.
    expect(ledger.todayFor('m1', EVENING_UTC, 'UTC')).toEqual(before);
  });

  /**
   * The seeding guard reads "did this start before today" in the office's
   * zone, so the same session is a backfill risk in one office and an ordinary
   * live session in another.
   *
   * A session that began at 23:00 IST on the 19th (17:30Z) is, at 02:00 IST on
   * the 20th: yesterday's session to a Kolkata office — seeded, because the
   * server has never seen it and it may be a replay — and today's to a UTC
   * office, which is still on the 19th and banks it.
   */
  it('decides “started before today” on the office’s calendar', () => {
    const startedAt = Date.parse('2026-08-19T17:30:00Z'); // 23:00 IST on the 19th
    const session = bucketed('s1', [bucket(KOLKATA_DAY, 1000)], startedAt);

    ledger.ingest('kolkata', [session], EVENING_UTC, KOLKATA);
    ledger.ingest('utc', [session], EVENING_UTC, 'UTC');

    // Seeded: the office is on a new date, so this is history and counts from
    // here on rather than being banked whole.
    expect(ledger.dayFor('kolkata', KOLKATA_DAY).tokens.input).toBe(0);
    // Banked: to the UTC office the session started this morning.
    expect(ledger.dayFor('utc', KOLKATA_DAY).tokens.input).toBe(1000);
  });

  /**
   * A collector too old to name a day gets the office's, which is the only
   * answer that keeps it visible: filed under any other date it would be
   * banked somewhere the board never looks.
   */
  it('files a pre-0.2 collector’s total on the office’s day', () => {
    ledger.ingest('m1', [flat('s1', 250, EVENING_UTC)], EVENING_UTC, KOLKATA);

    expect(ledger.todayFor('m1', EVENING_UTC, KOLKATA).tokens.input).toBe(250);
    expect(ledger.dayFor('m1', KOLKATA_DAY).tokens.input).toBe(250);
    expect(ledger.dayFor('m1', UTC_DAY).tokens.input).toBe(0);
  });

  /**
   * ...and so does the coarse minute mark that stands in for a bitmap it
   * cannot send. Two o'clock in the morning in Kolkata is minute 120 of the
   * Kolkata day, not minute 1230 of the UTC one.
   */
  it('marks the fallback minute on the office’s day', () => {
    ledger.ingest('m1', [flat('s1', 10, EVENING_UTC)], EVENING_UTC, KOLKATA);

    expect(ledger.dayFor('m1', KOLKATA_DAY).activeMinutes).toBe(1);
    expect(ledger.dayFor('m1', UTC_DAY).activeMinutes).toBe(0);
  });

  /**
   * ...and at the office's own hour, which is a second question and has caught
   * a second mistake: the day key can be right while the bit inside it is an
   * offset from somebody else's midnight.
   *
   * Two offices, one instant, and the mark located by ORing the office's own
   * bitmap for the minute it should be on — `activeMinutes` is a count, so a
   * bit landing beside the expected one reads as two rather than one. It is
   * half past one in the afternoon in California and two in the morning in
   * Kolkata, and no server clock is both, so a mark taken from the machine
   * fails one of these two wherever it runs.
   */
  it('marks the fallback minute at the office’s own hour', () => {
    const minutes = (day: string, list: number[]): SessionSnapshot => ({
      id: 's2',
      harness: 'claude-code',
      state: 'working',
      startedAt: EVENING_UTC,
      lastActivityAt: EVENING_UTC,
      activeMinutes: [{ day, minutes: encodeMinutes(list) }],
    });

    ledger.ingest('la', [flat('s1', 10, EVENING_UTC)], EVENING_UTC, CALIFORNIA);
    ledger.ingest('kol', [flat('s1', 10, EVENING_UTC)], EVENING_UTC, KOLKATA);
    ledger.ingest('la', [minutes(UTC_DAY, [13 * 60 + 30])], EVENING_UTC, CALIFORNIA);
    ledger.ingest('kol', [minutes(KOLKATA_DAY, [2 * 60])], EVENING_UTC, KOLKATA);

    expect(ledger.dayFor('la', UTC_DAY).activeMinutes).toBe(1);
    expect(ledger.dayFor('kol', KOLKATA_DAY).activeMinutes).toBe(1);
  });

  /**
   * A 0.2 collector's measured bitmap is never mixed with the server's coarse
   * mark, and the office's zone does not change that — the gate is still "did
   * this snapshot carry buckets at all".
   */
  it('still refuses to mix a measured bitmap with a coarse mark', () => {
    const session: SessionSnapshot = {
      ...bucketed('s1', [bucket(KOLKATA_DAY, 10)], EVENING_UTC),
      activeMinutes: [{ day: KOLKATA_DAY, minutes: encodeMinutes([5, 6]) }],
    };
    ledger.ingest('m1', [session], EVENING_UTC, KOLKATA);

    expect(ledger.dayFor('m1', KOLKATA_DAY).activeMinutes).toBe(2);
  });

  /**
   * The honest edge of the design: a member east of their office files work
   * under a date the office has not reached yet.
   *
   * It is kept, not dropped — nothing prunes a day key ahead of the window —
   * so it is delayed rather than lost, and it appears the moment the office's
   * own midnight arrives. That is the opposite failure from the one this item
   * exists to fix, where a member *west* of the server banked their evening
   * against a day that had already closed and was never displayed again.
   */
  it('holds a member’s day that is ahead of the office until the office reaches it', () => {
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(KOLKATA_DAY, 640)], EVENING_UTC)],
      EVENING_UTC,
      'UTC',
    );

    // Not on the UTC office's board yet: it is still the 19th there.
    expect(ledger.todayFor('m1', EVENING_UTC, 'UTC').tokens.input).toBe(0);
    // Nothing was thrown away, and three and a half hours later it is today.
    const afterMidnightUtc = Date.parse('2026-08-20T00:30:00Z');
    expect(ledger.todayFor('m1', afterMidnightUtc, 'UTC').tokens.input).toBe(640);
  });

  /**
   * The 25-hour day. An office on a DST-observing zone crosses its autumn
   * transition without the date repeating, without the fallback minute
   * escaping the bitmap it is written into, and without a session that started
   * that morning being mistaken for one that started yesterday.
   *
   * The invariant this *does* strain is the resume dedup split with the
   * collector, whose claim window is a flat 24h; the bound and its one-day-a-
   * year exposure are written down at `startedEarlier` in `foldUsage`.
   */
  it('crosses a fall-back transition as one long day', () => {
    const DAY = '2026-11-01';
    const beforeShift = Date.parse('2026-11-01T07:30:00Z'); // 00:30 PDT
    const afterShift = Date.parse('2026-11-01T09:30:00Z'); // 01:30 PST, an hour later
    const lateThatDay = Date.parse('2026-11-02T07:00:00Z'); // 23:00 PST, same date

    expect(TokenLedger.dayIn(beforeShift, CALIFORNIA)).toBe(DAY);
    expect(TokenLedger.dayIn(afterShift, CALIFORNIA)).toBe(DAY);
    expect(TokenLedger.dayIn(lateThatDay, CALIFORNIA)).toBe(DAY);

    // A session that began in the small hours is still "today" at eleven at
    // night, so its growth banks rather than seeding.
    ledger.ingest('m1', [bucketed('s1', [bucket(DAY, 100)], beforeShift)], beforeShift, CALIFORNIA);
    ledger.ingest('m1', [bucketed('s1', [bucket(DAY, 400)], beforeShift)], lateThatDay, CALIFORNIA);
    expect(ledger.dayFor('m1', DAY).tokens.input).toBe(400);

    // The coarse mark lands inside the 1440-bit day at both offsets, rather
    // than running off the end of it after the clocks go back.
    ledger.ingest('m2', [flat('s2', 5, beforeShift)], beforeShift, CALIFORNIA);
    ledger.ingest('m2', [flat('s2', 9, afterShift)], afterShift, CALIFORNIA);
    expect(ledger.dayFor('m2', DAY).activeMinutes).toBe(2);
  });

  /**
   * The spring transition is the same question with an hour missing: 02:00
   * never happens, the local day is 23 hours long, and the date still moves
   * exactly once.
   */
  it('crosses a spring-forward transition without skipping the date', () => {
    const before = Date.parse('2026-03-08T09:59:00Z'); // 01:59 PST
    const after = Date.parse('2026-03-08T10:01:00Z'); // 03:01 PDT
    expect(TokenLedger.dayIn(before, CALIFORNIA)).toBe('2026-03-08');
    expect(TokenLedger.dayIn(after, CALIFORNIA)).toBe('2026-03-08');
    // Midnight comes an hour earlier in UTC terms than it did the night
    // before, because the office is on PDT by then: 07:00Z, not 08:00Z.
    expect(TokenLedger.dayIn(Date.parse('2026-03-09T06:59:00Z'), CALIFORNIA)).toBe('2026-03-08');
    expect(TokenLedger.dayIn(Date.parse('2026-03-09T07:01:00Z'), CALIFORNIA)).toBe('2026-03-09');
  });
});
