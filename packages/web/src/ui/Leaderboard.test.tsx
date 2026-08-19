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

  it('still ranks by tokens when no row has a cost at all', () => {
    seed([row('a', 10, null), row('b', 900, null)]);
    render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'sort by estimated cost' }));
    expect(rendered()).toEqual(['b', 'a']);
  });
});
