// @vitest-environment jsdom
import type { MemberView, ServerToWeb, WebHistoryResult } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestHistory } from '../net/socket.js';
import { useStore } from '../store.js';
import { Greeting } from './Greeting.js';
import { HUD } from './HUD.js';

vi.mock('../net/socket.js', () => ({ requestHistory: vi.fn() }));

/**
 * The arrival moment: two lines about what the office did while somebody was
 * out, shown once per real absence and never for a reload.
 *
 * Whether it is *owed* is the server's judgement and is tested there — a
 * browser's clock is nobody's authority. What these cover is what the panel
 * does with the answer: which numbers it says out loud, whose it refuses to,
 * and that it goes away and stays away.
 */

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

const DAYS = ['2026-09-24', '2026-09-23', '2026-09-22'];

function member(id: string, sharing = true): MemberView {
  return {
    id,
    displayName: id,
    avatar: 'pixel',
    role: 'member',
    presence: 'active',
    position: { x: 0, y: 0, dir: 'down', moving: false },
    sessions: [],
    today: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 0,
      activeMinutes: 0,
    },
    sharing,
  };
}

function history(
  entries: { id: string; perDay?: Record<string, number>; withheld?: boolean }[],
): WebHistoryResult {
  return {
    type: 'history',
    days: DAYS,
    members: entries.map(({ id, perDay = {}, withheld }) =>
      withheld
        ? { memberId: id, displayName: id, avatar: 'pixel', days: [], tokensShared: false }
        : {
            memberId: id,
            displayName: id,
            avatar: 'pixel',
            days: DAYS.map((day) => ({
              day,
              stats: {
                tokens: { input: perDay[day] ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                sessionsRun: 0,
                activeMinutes: 0,
              },
            })),
          },
    ),
  };
}

/**
 * Arrive in an office, optionally as somebody the server judged to be coming
 * back. `sharing` is what decides whether the empty-avatar nudge is in play.
 */
function arrive({
  lastHereDay,
  members = ['me'],
  sharing = true,
}: {
  lastHereDay?: string;
  members?: string[];
  sharing?: boolean;
} = {}): void {
  useStore.getState().reset();
  localStorage.clear();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: members.map((id) => member(id, id === 'me' ? sharing : true)),
    leaderboard: [],
    ...(lastHereDay ? { lastHereDay } : {}),
  });
}

describe('the arrival greeting', () => {
  beforeEach(() => {
    useStore.getState().reset();
    localStorage.clear();
    vi.mocked(requestHistory).mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('leads with the machine that kept working while nobody was watching', () => {
    arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo'] });
    apply(history([{ id: 'me', perDay: { '2026-09-24': 2_100_000_000 } }, { id: 'lodo' }]));
    render(<Greeting />);

    expect(screen.getByText(/Your agents kept going/)).toBeTruthy();
    expect(screen.getByText('2.1B')).toBeTruthy();
  });

  it('names who led the office, and the room behind them', () => {
    arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo', 'nina'] });
    apply(
      history([
        { id: 'me' },
        { id: 'lodo', perDay: { '2026-09-24': 4_300_000_000 } },
        { id: 'nina', perDay: { '2026-09-24': 5_500_000_000 } },
      ]),
    );
    render(<Greeting />);

    expect(screen.getByText(/out front/)).toBeTruthy();
    expect(screen.getByText('nina')).toBeTruthy();
    expect(screen.getByText('9.8B')).toBeTruthy();
  });

  it('keeps it to one name when only one person moved', () => {
    arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo'] });
    apply(history([{ id: 'me' }, { id: 'lodo', perDay: { '2026-09-24': 4_300_000_000 } }]));
    render(<Greeting />);

    expect(screen.getByText(/burned/)).toBeTruthy();
    expect(screen.queryByText(/out front/)).toBeNull();
  });

  /**
   * The mutation this pins: a member who keeps their numbers to themselves must
   * never be named with a figure. The office serves them no days at all, so
   * turning that into a line would mean inventing one.
   */
  it('never puts a number against somebody who withholds', () => {
    arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo', 'nina'] });
    apply(
      history([
        { id: 'me' },
        { id: 'lodo', perDay: { '2026-09-24': 9_000_000_000 }, withheld: true },
        { id: 'nina', perDay: { '2026-09-24': 10_000 } },
      ]),
    );
    render(<Greeting />);

    expect(screen.queryByText('lodo')).toBeNull();
    expect(screen.getByText('nina')).toBeTruthy();
  });

  /** Away three days and the room stayed quiet. True, warm, and no guilt in it. */
  it('says the office was quiet rather than saying nothing', () => {
    arrive({ lastHereDay: '2026-09-22', members: ['me', 'lodo'] });
    apply(history([{ id: 'me' }, { id: 'lodo' }]));
    render(<Greeting />);

    expect(screen.getByText(/the office has been quiet/)).toBeTruthy();
    expect(screen.getByText(/since Tue 22 Sep/)).toBeTruthy();
  });

  it('says how long, in the days its numbers are actually made of', () => {
    arrive({ lastHereDay: '2026-09-23' });
    apply(history([{ id: 'me' }]));
    render(<Greeting />);

    expect(screen.getByText(/since yesterday/)).toBeTruthy();
  });

  /**
   * The mutation that matters most: a ninety-second blip carries no
   * `lastHereDay`, so there is nothing to greet. The office decides this, and
   * the panel has no opinion of its own to fall back on.
   */
  it('is not there at all for an arrival the office did not call a return', () => {
    arrive({ members: ['me', 'lodo'] });
    apply(history([{ id: 'me', perDay: { '2026-09-24': 9_000_000_000 } }, { id: 'lodo' }]));
    render(<Greeting />);

    expect(screen.queryByText(/While you were away/)).toBeNull();
  });

  /**
   * And the duplicate: greeted once, then the socket drops and comes back. The
   * office stamped this browser present on the way in, so the second `world`
   * carries nothing — and a `world` without the field has to *clear* what the
   * first one set rather than leave it standing.
   */
  it('does not come back on the reconnect behind it', () => {
    arrive({ lastHereDay: '2026-09-23' });
    apply(history([{ id: 'me', perDay: { '2026-09-24': 1_000 } }]));
    const { rerender } = render(<Greeting />);
    expect(screen.getByText(/While you were away/)).toBeTruthy();

    arrive();
    apply(history([{ id: 'me', perDay: { '2026-09-24': 1_000 } }]));
    rerender(<Greeting />);

    expect(screen.queryByText(/While you were away/)).toBeNull();
  });

  it('goes away when it is clicked, anywhere on it', () => {
    arrive({ lastHereDay: '2026-09-23' });
    apply(history([{ id: 'me', perDay: { '2026-09-24': 1_000 } }]));
    render(<Greeting />);

    fireEvent.click(screen.getByRole('button', { name: 'dismiss' }));

    expect(screen.queryByText(/While you were away/)).toBeNull();
    expect(useStore.getState().lastHereDay).toBeNull();
  });

  it('goes away on its own if nobody touches it', () => {
    vi.useFakeTimers();
    arrive({ lastHereDay: '2026-09-23' });
    apply(history([{ id: 'me', perDay: { '2026-09-24': 1_000 } }]));
    render(<Greeting />);
    expect(screen.getByText(/While you were away/)).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(20_000);
    });

    expect(screen.queryByText(/While you were away/)).toBeNull();
  });

  /**
   * It reads the answer the board and the week strips already share, through
   * the same idempotent call — the history budget is six a minute and a panel
   * that fetched on its own account would be the feature taxing the office.
   */
  it('asks for the office history the one way everything else does', () => {
    arrive({ lastHereDay: '2026-09-23' });
    render(<Greeting />);

    expect(vi.mocked(requestHistory)).toHaveBeenCalled();
  });

  it('draws nothing while the answer is still in flight', () => {
    arrive({ lastHereDay: '2026-09-23' });
    render(<Greeting />);

    expect(screen.queryByText(/While you were away/)).toBeNull();
  });

  /**
   * Two panels in one corner over somebody's first four seconds is the office
   * talking over itself. The nudge wins: it is the blocking problem, it is
   * asked once ever, and for a member with nothing sharing the greeting has no
   * line of their own to offer anyway.
   */
  describe('against the unpaired nudge', () => {
    it('stands aside for somebody who has nothing sharing yet', () => {
      arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo'], sharing: false });
      apply(history([{ id: 'me' }, { id: 'lodo', perDay: { '2026-09-24': 4_000 } }]));
      render(<HUD />);

      expect(screen.getByText(/nothing is sharing from your machine/)).toBeTruthy();
      expect(screen.queryByText(/While you were away/)).toBeNull();
    });

    it('greets a returning member who is set up', () => {
      arrive({ lastHereDay: '2026-09-23', members: ['me', 'lodo'], sharing: true });
      apply(history([{ id: 'me' }, { id: 'lodo', perDay: { '2026-09-24': 4_000 } }]));
      render(<HUD />);

      expect(screen.queryByText(/nothing is sharing from your machine/)).toBeNull();
      expect(screen.getByText(/While you were away/)).toBeTruthy();
    });
  });
});
