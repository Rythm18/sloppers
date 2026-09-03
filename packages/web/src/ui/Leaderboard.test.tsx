// @vitest-environment jsdom
import type { LeaderboardRow, ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store.js';
import { Leaderboard, sortRows } from './Leaderboard.js';

/**
 * The leaderboard has to hold two numbers at once — tokens, which we always
 * know, and cost, which we sometimes can't. These cover the decisions that
 * come out of that: where an unknown cost ranks, and that it never reads as
 * free.
 */

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

function row(
  memberId: string,
  tokens: number,
  estimatedCostUsd: number | null | undefined,
): LeaderboardRow {
  return {
    memberId,
    displayName: memberId,
    avatar: 'pixel',
    stats: {
      tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 1,
      activeMinutes: 1,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
    },
  };
}

/**
 * Two days in the *shapes* production actually produces, sized so that one
 * member plainly did more work than the other.
 *
 * `CLAUDE_DAY` is a real production row: 1,474 uncached input tokens against
 * 365M cache reads, a 99.9996% hit rate. `CODEX_DAY` is production's Codex row
 * divided by 200,000 — a constant, so the thing that matters survives it: the
 * share of tokens that land in `input + output` is 2.255% for Codex against
 * 0.279% for Claude Code, an 8.1x asymmetry that is a property of the harness
 * and not of the person.
 *
 * The result is a member who processed 366M tokens ranking *below* one who
 * processed 75M, because the second one's cache missed more often. That was
 * the board.
 */
const CLAUDE_DAY = { input: 1_474, output: 673_021, cacheRead: 365_482_656, cacheWrite: 0 };
const CODEX_DAY = { input: 1_151_032, output: 156_530, cacheRead: 73_562_986, cacheWrite: 0 };

function harnessRow(memberId: string, tokens: LeaderboardRow['stats']['tokens']): LeaderboardRow {
  return {
    memberId,
    displayName: memberId,
    avatar: 'pixel',
    stats: { tokens, sessionsRun: 1, activeMinutes: 1 },
  };
}

/**
 * A day the office cannot total but can partly price — the shape 41 of 41
 * Codex days have in production, and the one that used to rank last with an
 * empty bar however much it burned.
 */
function flooredRow(memberId: string, tokens: number, floor: number): LeaderboardRow {
  return {
    memberId,
    displayName: memberId,
    avatar: 'pixel',
    stats: {
      tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 1,
      activeMinutes: 1,
      byModel: {
        'gpt-5.6-sol': { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
        'codex-auto-review': { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      estimatedCostUsd: null,
      estimatedCostFloorUsd: floor,
    },
  };
}

/** A member whose collector says they keep their numbers to themselves. */
function privateRow(memberId: string): LeaderboardRow {
  return {
    memberId,
    displayName: memberId,
    avatar: 'pixel',
    stats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 0,
      activeMinutes: 0,
      estimatedCostUsd: 0,
      tokensShared: false,
    },
  };
}

function seed(rows: LeaderboardRow[]): void {
  useStore.getState().reset();
  apply({ type: 'leaderboard', rows });
}

/** Names in the order they are rendered. */
function rendered(): string[] {
  return [...document.querySelectorAll('.lb-row .who')].map((n) => n.textContent ?? '');
}

describe('sortRows', () => {
  it('ranks by tokens by default', () => {
    const rows = [row('a', 10, 99), row('b', 300, 1), row('c', 50, 50)];
    expect(sortRows(rows, 'tokens').map((r) => r.memberId)).toEqual(['b', 'c', 'a']);
  });

  it('ranks by cost when asked', () => {
    const rows = [row('a', 10, 3), row('b', 300, 1), row('c', 50, 50)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['c', 'a', 'b']);
  });

  it('sorts unknown costs last, under every priced row', () => {
    // Even a huge token count does not buy an unpriced day a high rank: we
    // genuinely do not know what it cost.
    const rows = [row('unknown', 9_000_000, null), row('cheap', 10, 0.01)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['cheap', 'unknown']);
  });

  it('does not treat an unknown cost as zero', () => {
    // A zero-cost row is a known quantity and outranks an unknown one.
    const rows = [row('unknown', 5, null), row('free', 5, 0)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['free', 'unknown']);
  });

  it('keeps unknown rows in token order among themselves', () => {
    const rows = [row('small', 5, null), row('big', 500, null)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['big', 'small']);
  });

  it('treats a missing estimate the same as an explicit null', () => {
    // Pre-0.2 servers never send the field at all.
    const rows = [row('absent', 900, undefined), row('priced', 1, 0.5)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['priced', 'absent']);
  });

  it('leaves the caller array untouched', () => {
    const rows = [row('a', 1, 1), row('b', 900, 2)];
    sortRows(rows, 'cost');
    expect(rows.map((r) => r.memberId)).toEqual(['a', 'b']);
  });

  it('ranks on every token processed, not on the ones that missed cache', () => {
    // The whole fix, and the mutation that has to fail here: `claude` moved
    // 366M tokens to `codex`'s 75M, and on input + output — which for Claude
    // Code is output and nothing else — `claude` ranked second, 674k to 1.3M.
    const rows = [harnessRow('codex', CODEX_DAY), harnessRow('claude', CLAUDE_DAY)];
    expect(sortRows(rows, 'tokens').map((r) => r.memberId)).toEqual(['claude', 'codex']);
    // Spelling out the inversion, so the fixture cannot quietly stop
    // demonstrating it.
    const billed = (t: typeof CLAUDE_DAY) => t.input + t.output;
    expect(billed(CODEX_DAY)).toBeGreaterThan(billed(CLAUDE_DAY));
  });

  it('ranks a floored day by its floor, not below everything', () => {
    // The inversion this fixes: the heaviest burner in the office sorted under
    // a $2 day because one of its models has no published price.
    const rows = [row('small', 10, 2), flooredRow('codex', 9_000_000, 40)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['codex', 'small']);
  });

  it('seats a floor under an exact total that beats it', () => {
    // A floor is a lower bound, so it can only claim the place its priced
    // share earns — never one above it.
    const rows = [flooredRow('codex', 9_000_000, 40), row('spender', 10, 90)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['spender', 'codex']);
  });

  it('compares two floors by their floors', () => {
    const rows = [flooredRow('lighter', 9_000_000, 3), flooredRow('heavier', 10, 30)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['heavier', 'lighter']);
  });

  it('puts a real floor above a day with no number at all', () => {
    const rows = [row('unknown', 9_000_000, null), flooredRow('floored', 10, 0.5)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['floored', 'unknown']);
  });

  it('sorts a day nothing could be priced in last, floor field or not', () => {
    const rows = [flooredRow('nothing-priced', 9_000_000, 0), row('cheap', 10, 0.01)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['cheap', 'nothing-priced']);
  });

  it('leaves the token sort alone', () => {
    // The floor is a cost-column repair. Ranked by tokens, the board must not
    // notice it exists.
    const rows = [flooredRow('floored', 10, 900), row('burner', 5_000, 1)];
    expect(sortRows(rows, 'tokens').map((r) => r.memberId)).toEqual(['burner', 'floored']);
  });

  it('breaks a cost tie on processed tokens too', () => {
    // The cost sort falls back to tokens for unknown and equal costs, so it
    // has to be ranking by the same quantity the tokens sort does.
    const rows = [harnessRow('codex', CODEX_DAY), harnessRow('claude', CLAUDE_DAY)];
    expect(sortRows(rows, 'cost').map((r) => r.memberId)).toEqual(['claude', 'codex']);
  });
});

describe('Leaderboard', () => {
  beforeEach(() => useStore.getState().reset());
  afterEach(cleanup);

  it('shows an estimated dollar figure beside the token count', () => {
    seed([row('ridham', 1000, 12.34)]);
    render(<Leaderboard />);
    expect(screen.getByText('$12')).toBeTruthy();
  });

  it('says an unknown cost in words rather than a bare dash', () => {
    seed([row('ridham', 1000, null)]);
    render(<Leaderboard />);
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText(/no est/i)).toBeTruthy();
  });

  it('explains the unknown on hover', () => {
    seed([row('ridham', 1000, null)]);
    render(<Leaderboard />);
    const cell = document.querySelector('.cost-unknown');
    expect(cell?.getAttribute('title')).toMatch(/no published price/i);
  });

  it('labels the number est. and dates it in the tooltip', () => {
    seed([row('ridham', 1000, 5)]);
    render(<Leaderboard />);
    expect(screen.getByText('est.')).toBeTruthy();
    const cell = document.querySelector('.cost');
    expect(cell?.getAttribute('title')).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(cell?.getAttribute('title')).toMatch(/not a bill/i);
  });

  it('starts on tokens and switches to cost on the toggle', () => {
    seed([row('spender', 10, 90), row('burner', 5000, 1)]);
    render(<Leaderboard />);
    expect(rendered()).toEqual(['burner', 'spender']);

    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));

    expect(rendered()).toEqual(['spender', 'burner']);
  });

  it('marks which sort is active', () => {
    seed([row('a', 10, 1)]);
    render(<Leaderboard />);
    expect(
      screen.getByRole('button', { name: 'sort by tokens' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'sort by estimated cost' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('gives an unknown cost no meter when ranked by cost', () => {
    seed([row('priced', 10, 5), row('unknown', 5000, null)]);
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));

    const bars = [...document.querySelectorAll('.lb-meter > i')].map(
      (n) => (n as HTMLElement).style.width,
    );
    expect(bars[1]).toBe('0%');
  });

  // ------------------------------------------------- a floor, not a blank

  it('shows the priced share as a floor rather than nothing', () => {
    seed([flooredRow('codex', 9_000_000, 12.4)]);
    render(<Leaderboard />);

    expect(document.querySelector('.lb-row .cost')?.textContent).toBe('est.≥$12');
    expect(screen.queryByText(/no est/i)).toBeNull();
  });

  it('does not let a floor pass for an exact estimate', () => {
    // The failure mode this whole shape exists to avoid: an undercount wearing
    // a complete total's clothes.
    seed([flooredRow('codex', 9_000_000, 12.4)]);
    render(<Leaderboard />);
    expect(screen.queryByText('$12')).toBeNull();
    expect(document.querySelector('.cost-floor')).toBeTruthy();
  });

  it('says on hover what the number leaves out, and names it', () => {
    seed([flooredRow('codex', 9_000_000, 12.4)]);
    render(<Leaderboard />);
    const title = document.querySelector('.cost-floor')?.getAttribute('title') ?? '';
    expect(title).toMatch(/at least/i);
    expect(title).toContain('codex-auto-review');
  });

  it('admits on hover that the ranking uses the floor, when it is doing the ranking', () => {
    seed([flooredRow('codex', 9_000_000, 12.4)]);
    render(<Leaderboard />);
    expect(document.querySelector('.cost-floor')?.getAttribute('title')).not.toMatch(/ranked by/i);

    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));
    expect(document.querySelector('.cost-floor')?.getAttribute('title')).toMatch(/ranked by/i);
  });

  it('gives a floored day a meter, because it has a number to draw', () => {
    seed([row('priced', 10, 20), flooredRow('codex', 9_000_000, 10)]);
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));

    const bars = [...document.querySelectorAll('.lb-meter > i')].map(
      (n) => (n as HTMLElement).style.width,
    );
    expect(bars).toEqual(['100%', '50%']);
  });

  it('still ranks by tokens when no row has a cost at all', () => {
    seed([row('a', 10, null), row('b', 900, null)]);
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));
    expect(rendered()).toEqual(['b', 'a']);
  });

  it('shows a Claude Code day at the size the agent actually worked', () => {
    // 366M processed against 674k billed. The old number rendered "673k" for a
    // day the models chewed through a third of a billion tokens.
    seed([harnessRow('claude', CLAUDE_DAY)]);
    render(<Leaderboard />);
    expect(screen.getByText('366M')).toBeTruthy();
  });

  // --------------------------------------------------- privacy as an absence

  it('lists a member who withholds their numbers instead of dropping them', () => {
    // They used to fall through the "did anything happen" filter into the same
    // gap as somebody who had not started yet, and `LeaderboardRow` carried
    // nothing that could have told the two apart.
    seed([row('busy', 500, 1), privateRow('quiet')]);
    render(<Leaderboard />);
    expect(rendered()).toEqual(['busy', 'quiet']);
  });

  it('gives the withheld row no rank and no number', () => {
    seed([row('busy', 500, 1), privateRow('quiet')]);
    render(<Leaderboard />);

    const ranks = [...document.querySelectorAll('.lb-row .rank')].map((n) => n.textContent);
    expect(ranks).toEqual(['1', '–']);
    // Never `$0.00`, and never a zero token count: both are claims.
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText('private')).toBeTruthy();
  });

  it('says why on hover, so the absence is discoverable from the board itself', () => {
    seed([privateRow('quiet')]);
    render(<Leaderboard />);
    expect(document.querySelector('.lb-private')?.getAttribute('title')).toMatch(
      /keeps their numbers to themselves/i,
    );
  });

  it('does not call the office quiet when the only member there is private', () => {
    seed([privateRow('quiet')]);
    render(<Leaderboard />);
    expect(screen.queryByText(/suspiciously quiet/i)).toBeNull();
  });

  it('never gives a withholding member a floor, whatever the wire carries', () => {
    // The withheld state outranks every other reading of the row. A member who
    // turned sharing off midday still has real rows in the ledger, and a
    // "≥ $9" beside their name would publish the number they declined to give.
    const quiet = privateRow('quiet');
    quiet.stats = { ...quiet.stats, estimatedCostUsd: null, estimatedCostFloorUsd: 9 };
    seed([row('busy', 500, 1), quiet]);
    render(<Leaderboard />);

    expect(screen.queryByText(/≥/)).toBeNull();
    expect(screen.getByText('private')).toBeTruthy();
    expect([...document.querySelectorAll('.lb-row .rank')].map((n) => n.textContent)).toEqual([
      '1',
      '–',
    ]);
  });

  it('keeps a withheld floor out of the cost ranking entirely', () => {
    const quiet = privateRow('quiet');
    quiet.stats = { ...quiet.stats, estimatedCostUsd: null, estimatedCostFloorUsd: 900 };
    seed([quiet, row('busy', 500, 1)]);
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));

    // Ranked rows first, withheld beneath them — never sorted to the top by a
    // number they never agreed to publish.
    expect(rendered()).toEqual(['busy', 'quiet']);
  });

  it('keeps the withheld row zeroes out of the ranking and the meter', () => {
    // Their zeroes must not enter the meter's maximum or the ordering.
    seed([privateRow('quiet'), row('busy', 500, 1)]);
    render(<Leaderboard />);
    const bars = [...document.querySelectorAll('.lb-meter > i')].map(
      (n) => (n as HTMLElement).style.width,
    );
    expect(bars).toEqual(['100%']);
  });
});
