import type { MemberHistory, WebHistoryResult } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import { awayReport, awaySpan } from './away.js';

/**
 * What the office missed, read off the answer it already served. The panel on
 * top of this only turns numbers into sentences; every judgement about *whose*
 * numbers and *which* days is here.
 */

const DAYS = ['2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20'];

/** One member's entry, keyed the way the office keys its own answer. */
function member(memberId: string, perDay: Record<string, number>, withheld = false): MemberHistory {
  if (withheld) {
    // Exactly what the server sends for somebody whose collector says token
    // sharing is off: no days at all, and the flag saying why.
    return { memberId, displayName: memberId, avatar: 'pixel', days: [], tokensShared: false };
  }
  return {
    memberId,
    displayName: memberId,
    avatar: 'pixel',
    days: DAYS.map((day) => ({
      day,
      stats: {
        tokens: { input: perDay[day] ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionsRun: perDay[day] ? 1 : 0,
        activeMinutes: 0,
      },
    })),
  };
}

function history(members: MemberHistory[], days = DAYS): WebHistoryResult {
  return { type: 'history', days, members };
}

describe('what happened while you were away', () => {
  it('counts only the days that began after you left', () => {
    const report = awayReport(
      history([
        member('me', { '2026-09-24': 100, '2026-09-22': 9_000 }),
        member('lodo', { '2026-09-24': 400, '2026-09-22': 7_000 }),
      ]),
      '2026-09-23',
      'me',
    );

    // The 22nd is on the wrong side of the line and the 23rd is the day they
    // left on — neither is news, and the second would be their own work.
    expect(report?.days).toEqual(['2026-09-24']);
    expect(report?.mine).toBe(100);
    expect(report?.top).toEqual({ displayName: 'lodo', total: 400 });
    // Everyone else's — never including mine, which has its own line.
    expect(report?.others).toBe(400);
  });

  it('adds up a longer absence across every day of it', () => {
    const report = awayReport(
      history([
        member('me', { '2026-09-24': 1, '2026-09-23': 2, '2026-09-22': 4 }),
        member('lodo', { '2026-09-23': 30, '2026-09-22': 70 }),
      ]),
      '2026-09-21',
      'me',
    );

    expect(report?.days).toEqual(['2026-09-24', '2026-09-23', '2026-09-22']);
    expect(report?.mine).toBe(7);
    expect(report?.top).toEqual({ displayName: 'lodo', total: 100 });
    expect(report?.movers).toBe(1);
  });

  it('puts the heaviest of several out front, and totals the room behind them', () => {
    const report = awayReport(
      history([
        member('me', {}),
        member('lodo', { '2026-09-24': 300 }),
        member('nina', { '2026-09-24': 900 }),
        member('theo', {}),
      ]),
      '2026-09-23',
      'me',
    );

    expect(report?.top).toEqual({ displayName: 'nina', total: 900 });
    expect(report?.movers).toBe(2);
    expect(report?.others).toBe(1_200);
  });

  it('never crowns a smaller number under the returner’s own bigger one', () => {
    // The panel's own premise: your agents ran all night, so the returner is
    // exactly the member likely to top the window. The first draft summed the
    // returner into the room's total while excluding them from the contest,
    // and read "the office burned 2.9B — lodo out front with 500M" one line
    // under their own 2.1B. Yours and everyone else's are disjoint sums.
    const report = awayReport(
      history([
        member('me', { '2026-09-24': 2_100_000 }),
        member('lodo', { '2026-09-24': 500_000 }),
        member('nina', { '2026-09-24': 300_000 }),
      ]),
      '2026-09-23',
      'me',
    );

    expect(report?.mine).toBe(2_100_000);
    expect(report?.others).toBe(800_000);
    expect(report?.top).toEqual({ displayName: 'lodo', total: 500_000 });
    // The returner never competes in the room's line, and their own total
    // never inflates it.
    expect(report?.others).toBeLessThan(report?.mine ?? 0);
  });

  /**
   * The withheld rule, and it holds because the wire never carried the
   * numbers: the office refuses to read a withholding member's stored days at
   * all, so there is nothing here to leak and nothing to rank them by.
   */
  it('says nothing about a member who keeps their numbers to themselves', () => {
    const report = awayReport(
      history([
        member('me', { '2026-09-24': 50 }),
        member('lodo', { '2026-09-24': 90 }, true),
        member('nina', { '2026-09-24': 10 }),
      ]),
      '2026-09-23',
      'me',
    );

    expect(report?.top).toEqual({ displayName: 'nina', total: 10 });
    expect(report?.movers).toBe(1);
    // Not in the room's total either — a sum they are absent from is the only
    // sum that does not quietly restate what they declined to say.
    expect(report?.others).toBe(10);
  });

  /**
   * The same rule, against a wire that carried the days anyway. Today's server
   * never does, and the flag is what the board's own `isPrivate` reads — so a
   * greeting that named and numbered somebody the board beside it refuses to
   * rank would be the panel contradicting the room.
   */
  it('refuses a withholding member even when their days arrive filled in', () => {
    const loud: MemberHistory = {
      ...member('lodo', { '2026-09-24': 9_000_000 }),
      tokensShared: false,
    };
    const report = awayReport(
      history([member('me', {}), loud, member('nina', { '2026-09-24': 5 })]),
      '2026-09-23',
      'me',
    );

    expect(report?.top).toEqual({ displayName: 'nina', total: 5 });
    expect(report?.others).toBe(5);
  });

  /**
   * Their own numbers are their own, and this is the shape that makes that a
   * non-question: a withholding member's collector never sent them, so the
   * office has nothing of theirs to hand back and their own line simply is not
   * there. The room's line still is.
   */
  it('leaves a withholding member with no line about themselves', () => {
    const report = awayReport(
      history([member('me', { '2026-09-24': 50 }, true), member('lodo', { '2026-09-24': 10 })]),
      '2026-09-23',
      'me',
    );

    expect(report?.mine).toBe(0);
    expect(report?.top).toEqual({ displayName: 'lodo', total: 10 });
  });

  it('reads a silent office as a silent office rather than as nothing to say', () => {
    const report = awayReport(history([member('me', {}), member('lodo', {})]), '2026-09-22', 'me');

    expect(report).not.toBeNull();
    expect(report?.mine).toBe(0);
    expect(report?.top).toBeNull();
    expect(report?.others).toBe(0);
  });

  it('has nothing to report when the served days do not reach past the absence', () => {
    expect(awayReport(history([member('me', {})]), '2026-09-24', 'me')).toBeNull();
  });

  describe('how long it says you were gone', () => {
    it('calls one day since yesterday', () => {
      const report = awayReport(history([member('me', {})]), '2026-09-23', 'me');
      expect(report && awaySpan(report, '2026-09-23')).toBe('since yesterday');
    });

    it('names the day for anything longer', () => {
      const report = awayReport(history([member('me', {})]), '2026-09-21', 'me');
      expect(report && awaySpan(report, '2026-09-21')).toBe('since Mon 21 Sep');
    });

    /**
     * Away a fortnight, and the office keeps five days. Naming the date they
     * left on would put a true sentence over numbers that do not cover it, so
     * the span says what is actually being reported instead.
     */
    it('says what it is reporting on when the absence outruns the history', () => {
      const report = awayReport(history([member('me', {})]), '2026-09-10', 'me');
      expect(report?.clamped).toBe(true);
      expect(report && awaySpan(report, '2026-09-10')).toBe('the last 5 days');
    });
  });
});
