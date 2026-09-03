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

function member(today: DailyStats, sessions: MemberView['sessions'] = []): MemberView {
  return {
    id: 'me',
    displayName: 'ridham',
    avatar: 'pixel',
    role: 'owner',
    presence: 'active',
    position: { x: 0, y: 0, dir: 'down', moving: false },
    sessions,
    today,
    sharing: true,
  };
}

function seed(today: DailyStats, sessions: MemberView['sessions'] = []): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: [member(today, sessions)],
    leaderboard: [],
  });
  act(() => useStore.getState().setFocused('me'));
}

/** One live session, as a withholding member's collector still reports it. */
const LIVE_SESSION: MemberView['sessions'] = [
  {
    id: 'sess-1',
    harness: 'codex',
    state: 'working',
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now(),
  },
];

/** The today line, as its visible text. */
function todayLine(): string {
  return document.querySelector('.member-today')?.textContent ?? '';
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
      ['gpt-5.6-sol', '1M', 'est.$4.00'],
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

  // ------------------------------------------------ the board's own headline

  it('leads with every token processed, cache reads included', () => {
    // A real Claude Code day: 1,474 uncached input against 365M cache reads.
    // Input + output rendered this as "674k" — output alone, in effect.
    seed({
      tokens: { input: 1_474, output: 673_021, cacheRead: 365_482_656, cacheWrite: 0 },
      sessionsRun: 3,
      activeMinutes: 40,
    });
    render(<MemberCard />);
    expect(todayLine()).toContain('366M');
  });

  it('keeps a model whose whole day was cache reads in the breakdown', () => {
    // On input + output this row vanished while still contributing its entire
    // cost to the total below it — and, when unpriced, nulling that total with
    // nothing on screen to name the culprit.
    seed({
      tokens: { input: 0, output: 0, cacheRead: 2_000_000, cacheWrite: 0 },
      sessionsRun: 1,
      activeMinutes: 5,
      byModel: {
        'claude-opus-5': { input: 0, output: 0, cacheRead: 2_000_000, cacheWrite: 0 },
      },
      estimatedCostUsd: 1,
    });
    render(<MemberCard />);
    expect(modelRows()).toEqual([['claude-opus-5', '2M', 'est.$1.00']]);
  });

  // -------------------------------------------------- privacy as an absence

  it('says a withholding member keeps their numbers, never that they are zero', () => {
    // What the tables hold for them, exactly: no rows, so `todayFor` returns
    // zeroes and a cost of 0 rather than null. Printed beside their own live
    // sessions, that read as a claim of having done nothing all day.
    seed(
      {
        tokens: tok(0),
        sessionsRun: 0,
        activeMinutes: 0,
        estimatedCostUsd: 0,
        tokensShared: false,
      },
      LIVE_SESSION,
    );
    render(<MemberCard />);

    expect(todayLine()).toContain('Keeps their numbers to themselves');
    expect(todayLine()).not.toContain('$0.00');
    expect(todayLine()).not.toContain('0 tok');
    expect(todayLine()).not.toContain('0 sessions');
    // Their live sessions are still listed — that part they do share.
    expect(document.querySelectorAll('.session-row')).toHaveLength(1);
  });

  it('explains the withheld state on hover', () => {
    seed({ tokens: tok(0), sessionsRun: 0, activeMinutes: 0, tokensShared: false });
    render(<MemberCard />);
    expect(document.querySelector('.member-today')?.getAttribute('title')).toMatch(
      /not zero: unsaid/i,
    );
  });

  it('hides the per-model breakdown from a member who turned sharing off midday', () => {
    // Rows banked before they switched it off are real, and showing them under
    // a line that says they share nothing would make that line untrue.
    seed({
      tokens: tok(1_000_000),
      sessionsRun: 2,
      activeMinutes: 30,
      byModel: { 'claude-opus-5': tok(1_000_000) },
      estimatedCostUsd: 5,
      tokensShared: false,
    });
    render(<MemberCard />);
    expect(screen.queryByText('Today by model')).toBeNull();
  });

  it('still shows the numbers when the collector says nothing about sharing', () => {
    // 0.1.x cannot state it. Absence is not a refusal.
    seed({ tokens: tok(1_000), sessionsRun: 1, activeMinutes: 5, estimatedCostUsd: 1 });
    render(<MemberCard />);
    expect(todayLine()).toContain('1k');
    expect(todayLine()).not.toContain('Keeps their numbers');
  });

  // ------------------------------------- two definitions sharing one column

  it('calls them conversations only when the collector grouped them', () => {
    seed({ tokens: tok(1_000), sessionsRun: 10, activeMinutes: 40, precision: 'measured' });
    render(<MemberCard />);
    expect(todayLine()).toContain('10 conversations');
    expect(todayLine()).not.toContain('≈');
  });

  it('keeps the older word, and explains it, when the count is per transcript file', () => {
    // The production day this is drawn from read 373 "sessions" against 139
    // real conversations. Calling those conversations would be a 2.7x lie;
    // calling them sessions is at least what was counted.
    seed({ tokens: tok(1_000), sessionsRun: 373, activeMinutes: 40, precision: 'coarse' });
    render(<MemberCard />);
    expect(todayLine()).toContain('373 sessions');
    const cell = [...document.querySelectorAll('.member-today span[title]')].find((n) =>
      n.textContent?.includes('373'),
    );
    expect(cell?.getAttribute('title')).toMatch(/per transcript file/i);
  });

  it('hedges coarse active minutes and explains what they measure', () => {
    // 1,315 minutes is 21.9 hours. The server marks a minute whenever a
    // session reads `working`, and a session stays `working` for ten minutes
    // after its last output — so this is an agent lifespan, not a workday.
    seed({ tokens: tok(1_000), sessionsRun: 1, activeMinutes: 1315, precision: 'coarse' });
    render(<MemberCard />);
    expect(todayLine()).toContain('≈1315 active min');
    const cell = [...document.querySelectorAll('.member-today span[title]')].find((n) =>
      n.textContent?.includes('active min'),
    );
    expect(cell?.getAttribute('title')).toMatch(/approximate/i);
  });

  it('does not hedge minutes a collector actually measured', () => {
    seed({ tokens: tok(1_000), sessionsRun: 1, activeMinutes: 42, precision: 'measured' });
    render(<MemberCard />);
    expect(todayLine()).toContain('42 active min');
    expect(todayLine()).not.toContain('≈');
  });

  it('hedges a day it cannot classify, rather than claiming it was measured', () => {
    // No usage rows means no verdict. `≈` is the humble direction, and the one
    // that cannot overstate.
    seed({ tokens: tok(0), sessionsRun: 0, activeMinutes: 9 });
    render(<MemberCard />);
    expect(todayLine()).toContain('≈9 active min');
  });

  it('renders a day with nothing in it without inventing anything', () => {
    seed({ tokens: tok(0), sessionsRun: 0, activeMinutes: 0, estimatedCostUsd: 0 });
    render(<MemberCard />);
    expect(todayLine()).toContain('0 tok');
    expect(todayLine()).toContain('0 sessions');
    expect(todayLine()).toContain('est.$0.00');
  });
});
