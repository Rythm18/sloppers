import type { DailyStats } from '@sloppers/protocol';
import { describe, expect, it } from 'vitest';
import {
  activeMinutes,
  burned,
  COST_FLOOR_MARK,
  COST_FLOOR_RANK_NOTE,
  COST_UNKNOWN,
  COST_UNKNOWN_TITLE,
  chatTime,
  costFloorTitle,
  costTitle,
  countdown,
  dayCostView,
  dayLabel,
  dayTitle,
  formatCostUsd,
  formatTokens,
  MINUTES_COARSE_TITLE,
  modelCostView,
  SESSIONS_COARSE_TITLE,
  sessionLine,
  sessionsLabel,
  TOKENS_PRIVATE,
  TOKENS_PRIVATE_LINE,
  weekdayInitial,
} from './format.js';

/** A day with only the fields under test set. */
function day(over: Partial<DailyStats> = {}): DailyStats {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessionsRun: 0,
    activeMinutes: 0,
    ...over,
  };
}

describe('countdown', () => {
  it('reads as a clock rather than a number to divide', () => {
    expect(countdown(600)).toBe('10:00');
    expect(countdown(587)).toBe('9:47');
    expect(countdown(9)).toBe('0:09');
    expect(countdown(0)).toBe('0:00');
  });

  it('clamps a deadline that has already passed', () => {
    // The share dialog stops ticking at zero and the sign-in one goes
    // negative on its way to being dismissed; neither may render "-1:-3".
    expect(countdown(-63)).toBe('0:00');
  });
});

describe('formatTokens', () => {
  it('keeps small numbers plain', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('abbreviates thousands and millions', () => {
    expect(formatTokens(1_200)).toBe('1.2k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(999_999)).toBe('1000k');
    expect(formatTokens(5_400_000)).toBe('5.4M');
    expect(formatTokens(123_000_000)).toBe('123M');
  });

  it('drops trailing .0', () => {
    expect(formatTokens(2_000)).toBe('2k');
    expect(formatTokens(3_000_000)).toBe('3M');
  });

  it('abbreviates billions and trillions', () => {
    // Without a B tier a real Codex day renders as "2228833M", which is nine
    // characters of noise where the leaderboard has room for four.
    expect(formatTokens(2_228_833_000_000)).toBe('2.2T');
    expect(formatTokens(2_800_000_000)).toBe('2.8B');
    expect(formatTokens(122_584_877_154)).toBe('123B');
    expect(formatTokens(1_000_000_000)).toBe('1B');
    expect(formatTokens(19_542_891_244)).toBe('19.5B');
  });

  it('changes tier exactly at each boundary', () => {
    expect(formatTokens(999_999_999)).toBe('1000M');
    expect(formatTokens(1_000_000_000)).toBe('1B');
    expect(formatTokens(999_999_999_999)).toBe('1000B');
    expect(formatTokens(1_000_000_000_000)).toBe('1T');
  });

  it('never renders a huge number as raw digits', () => {
    // The pixel budget is the point: every tier stays inside six characters.
    for (const n of [1e3, 1e6, 1e9, 1e12, 4.2e13, 9.9e14]) {
      expect(formatTokens(n).length).toBeLessThanOrEqual(6);
    }
  });
});

describe('formatCostUsd', () => {
  it('keeps cents while cents are the story', () => {
    expect(formatCostUsd(0.01)).toBe('$0.01');
    expect(formatCostUsd(0.42)).toBe('$0.42');
    expect(formatCostUsd(3.07)).toBe('$3.07');
    expect(formatCostUsd(9.99)).toBe('$9.99');
  });

  it('drops invented precision once the total is large', () => {
    // An estimate from list prices cannot really justify cents at this size.
    expect(formatCostUsd(10)).toBe('$10');
    expect(formatCostUsd(12.34)).toBe('$12');
    expect(formatCostUsd(340.7)).toBe('$341');
    expect(formatCostUsd(1234.5)).toBe('$1,235');
  });

  it('never collapses real spend to $0.00', () => {
    // The failure this rule exists to prevent: a day that cost four tenths of
    // a cent must not render as free.
    expect(formatCostUsd(0.004)).toBe('<$0.01');
    expect(formatCostUsd(0.0000051)).toBe('<$0.01');
    expect(formatCostUsd(0.009)).toBe('$0.01');
  });

  it('says $0.00 only for genuinely nothing', () => {
    expect(formatCostUsd(0)).toBe('$0.00');
  });

  it('crosses the cents/dollars boundary on the rounded value', () => {
    // 9.999 rounds to 10.00; showing "$10.00" beside "$10" would look like two
    // different formats for the same number.
    expect(formatCostUsd(9.999)).toBe('$10');
    expect(formatCostUsd(9.994)).toBe('$9.99');
  });

  it('is never blank or NaN for a hostile number', () => {
    expect(formatCostUsd(Number.NaN)).toBe('$0.00');
    expect(formatCostUsd(Number.POSITIVE_INFINITY)).toBe('$0.00');
    expect(formatCostUsd(-5)).toBe('$0.00');
  });
});

describe('cost wording', () => {
  it('names unknown in words, not as a bare dash', () => {
    // A dash beside real dollars cannot be told apart from zero.
    expect(COST_UNKNOWN).not.toBe('—');
    expect(COST_UNKNOWN).toMatch(/est/i);
    expect(COST_UNKNOWN).not.toBe(formatCostUsd(0));
  });

  it('explains why an unknown cost is missing', () => {
    expect(COST_UNKNOWN_TITLE).toMatch(/no published price/i);
  });

  it('dates the estimate and denies being a bill', () => {
    const title = costTitle();
    expect(title).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(title).toMatch(/estimat/i);
    expect(title).toMatch(/not a bill/i);
    // The three things it must not be mistaken for.
    expect(title).toMatch(/subscription/i);
    expect(title).toMatch(/discount/i);
  });
});

/**
 * The third answer, between a total and a blank. A floor has to *look* like a
 * floor everywhere it appears: rendered as a plain estimate it becomes the
 * silent undercount the null contract exists to prevent.
 */
describe('cost floors', () => {
  const M = 1_000_000;
  const tok = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

  it('marks a floor as a lower bound, never as a plain estimate', () => {
    const view = dayCostView(
      day({ estimatedCostUsd: null, estimatedCostFloorUsd: 12.4, byModel: {} }),
    );
    expect(view.kind).toBe('floor');
    expect(view.text).toBe('≥$12');
    expect(view.text).toContain(COST_FLOOR_MARK);
    expect(view.text).not.toBe(formatCostUsd(12.4));
  });

  it('renders an exact estimate exactly as it always did', () => {
    const view = dayCostView(day({ estimatedCostUsd: 5, estimatedCostFloorUsd: 5 }));
    expect(view).toEqual({ kind: 'exact', text: '$5.00', title: costTitle(), usd: 5 });
  });

  it('rounds a floor down, because "at least" must not overstate itself', () => {
    // Nearest-rounding would print ≥$13 on a $12.60 floor — a false claim.
    // An estimate may round either way; a bound only ever understates.
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 12.6 })).text).toBe(
      '≥$12',
    );
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 0.126 })).text).toBe(
      '≥$0.12',
    );
    // And a floor that only *rounds up* to a cent has nothing true to print.
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 0.007 })).kind).toBe(
      'unknown',
    );
  });

  it('still says no est. when nothing in the day could be priced', () => {
    // A floor of $0.00 is not a small amount of information; it is none, and
    // printed as money it reads as free.
    const view = dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 0 }));
    expect(view.kind).toBe('unknown');
    expect(view.text).toBe(COST_UNKNOWN);
    expect(view.usd).toBeNull();
  });

  it('says no est. for a floor too small to round to a cent', () => {
    // "at least less than a cent" is a sentence with no content.
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 0.004 })).kind).toBe(
      'unknown',
    );
  });

  it('keeps a genuinely free priced day distinguishable from an unpriced one', () => {
    expect(dayCostView(day({ estimatedCostUsd: 0, estimatedCostFloorUsd: 0 })).text).toBe('$0.00');
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 0 })).text).toBe(
      COST_UNKNOWN,
    );
  });

  it('leaves a server too old to send a floor exactly where it was', () => {
    const view = dayCostView(day({ estimatedCostUsd: null }));
    expect(view.kind).toBe('unknown');
  });

  it('ranks on the floor, so a floored day is not sorted as if it had nothing', () => {
    expect(dayCostView(day({ estimatedCostUsd: null, estimatedCostFloorUsd: 12.4 })).usd).toBe(
      12.4,
    );
  });

  it('names the models that are missing from the number', () => {
    const view = dayCostView(
      day({
        estimatedCostUsd: null,
        estimatedCostFloorUsd: 4,
        byModel: { 'gpt-5.6-sol': tok(M), 'codex-auto-review': tok(M) },
      }),
    );
    expect(view.title).toContain('codex-auto-review');
    expect(view.title).not.toContain('gpt-5.6-sol');
  });

  it('says what the number is and that the rest is unsayable', () => {
    const title = costFloorTitle(['codex-auto-review']);
    expect(title).toMatch(/at least/i);
    expect(title).toMatch(/no published price/i);
    expect(title).toMatch(/higher/i);
    // Still an estimate, so it still carries the estimate's own caveat.
    expect(title).toMatch(/not a bill/i);
  });

  it('keeps the tooltip short when a day is unpriced many ways over', () => {
    const title = costFloorTitle(['a', 'b', 'c', 'd', 'e']);
    expect(title).toContain('a, b, c and 2 more');
  });

  it('still explains itself when the breakdown never arrived', () => {
    expect(costFloorTitle([])).toMatch(/no published price/i);
  });

  it('admits that ranking by a floor can seat a day too low', () => {
    expect(COST_FLOOR_RANK_NOTE).toMatch(/lower/i);
  });

  it('gives one model row an estimate or a named absence, never a floor', () => {
    // The finest grain there is: a model is priced or it is not.
    expect(modelCostView(0.1).kind).toBe('exact');
    expect(modelCostView(null).kind).toBe('unknown');
    expect(modelCostView(null).text).toBe(COST_UNKNOWN);
  });
});

describe('burned', () => {
  it('counts all four token classes, not the two that were billed', () => {
    // A Claude Code day: 1,474 uncached input against 365M cache reads. On
    // input + output this reads "674k" — output alone, for the same work.
    const claudeDay = { input: 1_474, output: 673_021, cacheRead: 365_482_656, cacheWrite: 0 };
    expect(burned(claudeDay)).toBe('366M');
  });

  it('counts a pure cache-read day as work, because it was', () => {
    expect(burned({ input: 0, output: 0, cacheRead: 2_400_000_000, cacheWrite: 0 })).toBe('2.4B');
  });

  it('still says nothing for a day with nothing in it', () => {
    expect(burned({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe('0');
  });
});

describe('privacy wording', () => {
  it('reads as a state, never as a quantity', () => {
    // The failure it replaces was `$0.00` and `0 tok` — numbers nobody
    // asserted, standing in for a person who declined to.
    expect(TOKENS_PRIVATE).not.toMatch(/\d/);
    expect(TOKENS_PRIVATE).not.toBe(formatCostUsd(0));
    expect(TOKENS_PRIVATE_LINE).toMatch(/keeps their numbers to themselves/i);
  });
});

describe('sessionsLabel', () => {
  it('says conversations only when the collector grouped them into conversations', () => {
    expect(sessionsLabel(day({ precision: 'measured' }), 4)).toBe('conversations');
    expect(sessionsLabel(day({ precision: 'measured' }), 1)).toBe('conversation');
  });

  it('keeps the older word for a per-file count, which is what it is', () => {
    // 599 transcript files for 139 conversations on the local corpus. Calling
    // that "conversations" would be a 4.3x claim we cannot make.
    expect(sessionsLabel(day({ precision: 'coarse' }), 373)).toBe('sessions');
    expect(sessionsLabel(day({ precision: 'coarse' }), 1)).toBe('session');
  });

  it('does not upgrade the word on a day it cannot classify', () => {
    expect(sessionsLabel(day(), 2)).toBe('sessions');
  });

  it('explains what a per-file count actually counted', () => {
    expect(SESSIONS_COARSE_TITLE).toMatch(/per transcript file/i);
    expect(SESSIONS_COARSE_TITLE).toMatch(/fork|resume|subagent/i);
  });
});

describe('activeMinutes', () => {
  it('hedges the coarse server mark', () => {
    expect(activeMinutes(day({ precision: 'coarse' })).prefix).toBe('≈');
  });

  it('does not hedge minutes the collector measured', () => {
    expect(activeMinutes(day({ precision: 'measured' })).prefix).toBe('');
  });

  it('hedges an unclassifiable day rather than claiming precision', () => {
    // Absent means we cannot tell. Understating confidence is the only
    // direction that cannot mislead.
    expect(activeMinutes(day()).prefix).toBe('≈');
  });

  it('says what the coarse number is actually measuring', () => {
    expect(MINUTES_COARSE_TITLE).toMatch(/approximate/i);
    expect(MINUTES_COARSE_TITLE).toMatch(/ten minutes/i);
    expect(MINUTES_COARSE_TITLE).toMatch(/keyboard/i);
  });
});

describe('sessionLine', () => {
  const base = {
    id: 's',
    harness: 'claude-code',
    state: 'working',
    startedAt: 1,
    lastActivityAt: 1,
  } as const;

  it('prefers title, then project, then harness', () => {
    expect(sessionLine({ ...base, title: 'Fixing the build', project: 'app' })).toBe(
      'Fixing the build',
    );
    expect(sessionLine({ ...base, project: 'app' })).toBe('app');
    expect(sessionLine(base)).toBe('claude session');
  });
});

/**
 * The exception to everything the day labels below are careful about, and the
 * exception is the point: a chat timestamp is a *moment*, the same instant for
 * everybody, so the only useful way to show it is as the time it was where the
 * person reading is. A day key is a label cut from somebody else's calendar,
 * and rewriting one into the reader's clock moves Monday's work under Sunday.
 */
describe('chatTime', () => {
  it('reads a moment as the clock of whoever is looking at it', () => {
    const when = new Date(2026, 8, 2, 9, 7);
    expect(chatTime(when.getTime())).toBe('09:07');
    expect(chatTime(new Date(2026, 8, 2, 23, 59).getTime())).toBe('23:59');
    expect(chatTime(new Date(2026, 8, 2, 0, 0).getTime())).toBe('00:00');
  });
});

describe('day labels', () => {
  it('gives a week strip one letter per day', () => {
    // 2026-08-31 is a Monday; the week runs from there.
    expect(
      [
        '2026-08-31',
        '2026-09-01',
        '2026-09-02',
        '2026-09-03',
        '2026-09-04',
        '2026-09-05',
        '2026-09-06',
      ].map(weekdayInitial),
    ).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('reads a day key the same way wherever the reader is', () => {
    // The key is a label cut from somebody else's calendar, not a moment. Read
    // as local midnight it would slide a day for anybody west of the writer,
    // and Monday's bar would sit under Sunday's initial.
    expect(dayLabel('2026-09-02')).toBe('Wed 2 Sep');
    expect(dayLabel('2026-01-01')).toBe('Thu 1 Jan');
    expect(dayLabel('2026-12-31')).toBe('Thu 31 Dec');
  });

  it('hands back anything it cannot read rather than inventing a date', () => {
    expect(dayLabel('not-a-day')).toBe('not-a-day');
    expect(weekdayInitial('not-a-day')).toBe('');
  });

  it('says a day off in words rather than reporting nothing spent', () => {
    expect(dayTitle('2026-09-02', day())).toBe('Wed 2 Sep — nothing burned');
  });

  it('carries every hedge today gets into a past day', () => {
    // A day recorded by a pre-0.2 collector counts transcript files, and says
    // so here as plainly as it does on the card.
    const coarse = dayTitle(
      '2026-09-02',
      day({
        tokens: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionsRun: 3,
        precision: 'coarse',
      }),
    );
    expect(coarse).toBe(`Wed 2 Sep — 1.2k tok · 3 sessions · ${COST_UNKNOWN}`);
    const measured = dayTitle(
      '2026-09-02',
      day({
        tokens: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionsRun: 3,
        precision: 'measured',
      }),
    );
    expect(measured).toContain('3 conversations');
  });

  it('floors a past day the way it floors today', () => {
    const floored = dayTitle(
      '2026-09-02',
      day({
        tokens: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionsRun: 1,
        estimatedCostUsd: null,
        estimatedCostFloorUsd: 12.4,
      }),
    );
    expect(floored).toContain(`${COST_FLOOR_MARK}$12`);
  });

  it('says a past day it cannot price at all is unpriced', () => {
    const unknown = dayTitle(
      '2026-09-02',
      day({
        tokens: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 },
        sessionsRun: 1,
        estimatedCostUsd: null,
      }),
    );
    expect(unknown).toContain(COST_UNKNOWN);
  });
});
