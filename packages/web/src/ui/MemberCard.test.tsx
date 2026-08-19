// @vitest-environment jsdom
import type { DailyStats, MemberView, ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../store.js';
import { MemberCard } from './MemberCard.js';

/**
 * The card is where a total gets broken back down. The per-model list is the
 * only place that can explain *why* a day has no estimate, so an unpriced
 * model has to be visible in it by name.
 */

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

const tok = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

function member(today: DailyStats): MemberView {
  return {
    id: 'me',
    displayName: 'ridham',
    avatar: 'pixel',
    role: 'owner',
    presence: 'active',
    position: { x: 0, y: 0, dir: 'down', moving: false },
    sessions: [],
    today,
    sharing: true,
  };
}

function seed(today: DailyStats): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: [member(today)],
    leaderboard: [],
  });
  act(() => useStore.getState().setFocused('me'));
}

/** The per-model list, as [model, tokens, cost] triples. */
function modelRows(): string[][] {
  return [...document.querySelectorAll('.model-row')].map((r) =>
    [...r.children].map((c) => c.textContent ?? ''),
  );
}

describe('MemberCard', () => {
  beforeEach(() => useStore.getState().reset());
  afterEach(cleanup);

  it('breaks the day down per model, heaviest first', () => {
    seed({
      tokens: tok(1_100_000),
      sessionsRun: 1,
      activeMinutes: 5,
      byModel: {
        'claude-haiku-4-5': tok(100_000),
        'claude-opus-5': tok(1_000_000),
      },
      estimatedCostUsd: 5.1,
    });
    render(<MemberCard />);

    expect(modelRows()).toEqual([
      ['claude-opus-5', '1M', 'est.$5.00'],
      ['claude-haiku-4-5', '100k', 'est.$0.10'],
    ]);
  });

  it('names the unpriced model that makes the day unknown', () => {
    // The total is null; without this row nobody could tell which model did it.
    seed({
      tokens: tok(2_000_000),
      sessionsRun: 1,
      activeMinutes: 5,
      byModel: {
        'gpt-5.6-sol': tok(1_000_000),
        'codex-auto-review': tok(1_000_000),
      },
      estimatedCostUsd: null,
    });
    render(<MemberCard />);

    expect(modelRows()).toEqual([
      ['gpt-5.6-sol', '1M', 'est.$5.00'],
      ['codex-auto-review', '1M', 'no est.'],
    ]);
  });

  it('shows the day total as an estimate, not a bill', () => {
    seed({ tokens: tok(1_000_000), sessionsRun: 1, activeMinutes: 5, estimatedCostUsd: 5 });
    render(<MemberCard />);

    const cell = document.querySelector('.member-today .cost');
    expect(cell?.textContent).toBe('est.$5.00');
    expect(cell?.getAttribute('title')).toMatch(/not a bill/i);
    expect(cell?.getAttribute('title')).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('says the day total is unknown rather than zero', () => {
    seed({ tokens: tok(1_000_000), sessionsRun: 1, activeMinutes: 5, estimatedCostUsd: null });
    render(<MemberCard />);

    const cell = document.querySelector('.member-today .cost');
    expect(cell?.textContent).toBe('no est.');
    expect(cell?.getAttribute('title')).toMatch(/no published price/i);
  });

  it('prices the dated Haiku string the collector actually sends', () => {
    seed({
      tokens: tok(1_000_000),
      sessionsRun: 1,
      activeMinutes: 5,
      byModel: { 'claude-haiku-4-5-20251001': tok(1_000_000) },
      estimatedCostUsd: 1,
    });
    render(<MemberCard />);

    expect(modelRows()).toEqual([['claude-haiku-4-5-20251001', '1M', 'est.$1.00']]);
  });

  it('omits the breakdown entirely when the server sent none', () => {
    // Pre-0.2 servers send no byModel at all; the card must not grow an empty
    // "Today by model" heading over nothing.
    seed({ tokens: tok(0), sessionsRun: 0, activeMinutes: 0 });
    render(<MemberCard />);

    expect(screen.queryByText('Today by model')).toBeNull();
    expect(modelRows()).toEqual([]);
  });

  it('drops zero-token models from the breakdown', () => {
    seed({
      tokens: tok(1_000_000),
      sessionsRun: 1,
      activeMinutes: 5,
      byModel: { 'claude-opus-5': tok(1_000_000), 'claude-sonnet-5': tok(0) },
      estimatedCostUsd: 5,
    });
    render(<MemberCard />);

    expect(modelRows().map((r) => r[0])).toEqual(['claude-opus-5']);
  });

  it('costs a genuinely free day at zero, not unknown', () => {
    seed({ tokens: tok(0), sessionsRun: 1, activeMinutes: 2, estimatedCostUsd: 0 });
    render(<MemberCard />);

    expect(document.querySelector('.member-today .cost')?.textContent).toBe('est.$0.00');
  });
});
