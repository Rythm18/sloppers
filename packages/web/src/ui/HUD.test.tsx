// @vitest-environment jsdom
import type { KnockView, MemberRole, ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store.js';
import { HUD } from './HUD.js';

/**
 * The HUD is the only thing on screen while somebody waits at the door, so
 * the wait has to be visible from here — and settings have to be reachable
 * by everyone, since the way out of an office is in them.
 */

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

function knock(id: string, displayName: string): KnockView {
  return { id, displayName, avatar: 'pixel', requestedAt: 1 };
}

function member(id: string, role: MemberRole, sharing: boolean) {
  return {
    id,
    displayName: id,
    avatar: 'pixel',
    role,
    presence: 'active' as const,
    position: { x: 0, y: 0, dir: 'down' as const, moving: false },
    sessions: [],
    today: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      sessionsRun: 0,
      activeMinutes: 0,
    },
    sharing,
  };
}

function seed(
  role: MemberRole,
  knocks: KnockView[] = [],
  { sharing = false, me = 'me', alone = true } = {},
): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: me },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: alone
      ? [member(me, role, sharing)]
      : [member(me, role, sharing), member('nina', 'member', true)],
    leaderboard: [],
  });
  if (knocks.length > 0) apply({ type: 'knocks', knocks });
}

/**
 * Answer the pointer query the way a mouse or a finger would. jsdom has a
 * `matchMedia` that says no to everything, which is exactly a desktop — so
 * only the touch half needs saying, but both are stated to keep the pair
 * readable.
 */
function pointerIs(kind: 'coarse' | 'fine'): void {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media.includes('pointer: coarse') && kind === 'coarse',
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('HUD', () => {
  beforeEach(() => {
    useStore.getState().reset();
    // The nudge remembers being answered, and remembering it between tests
    // would make every one of them depend on the order they ran in.
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('offers settings to everyone — a member reaches their own way out through it', () => {
    seed('member');
    render(<HUD />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it('shows a waiting knock without the panel being open, and opens it', () => {
    seed('moderator', [knock('k1', 'theo')]);
    render(<HUD />);

    const alert = screen.getByRole('button', { name: 'Someone at the door' });
    fireEvent.click(alert);

    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it('counts them once there is a queue', () => {
    seed('owner', [knock('k1', 'theo'), knock('k2', 'nina')]);
    render(<HUD />);

    expect(screen.getByRole('button', { name: '2 at the door' })).toBeTruthy();
  });

  it('says nothing about the door to someone who cannot answer it', () => {
    seed('member', [knock('k1', 'theo')]);
    render(<HUD />);

    expect(screen.queryByRole('button', { name: /at the door/ })).toBeNull();
  });

  it('says nothing when nobody is waiting', () => {
    seed('owner');
    render(<HUD />);

    expect(screen.queryByRole('button', { name: /at the door/ })).toBeNull();
  });

  // The office's one instruction. Offering WASD to a phone is not a smaller
  // help than none — it is the screen telling somebody the controls they can
  // see are all there is, and there is no keyboard coming.
  it('names the keys to somebody holding a mouse', () => {
    pointerIs('fine');
    seed('member');
    render(<HUD />);

    expect(screen.getByText(/WASD or arrows to walk/)).toBeTruthy();
    expect(screen.queryByText(/Tap the floor/)).toBeNull();
  });

  it('tells a finger to tap, and never mentions a key it does not have', () => {
    pointerIs('coarse');
    seed('member');
    render(<HUD />);

    expect(screen.getByText(/Tap the floor to walk/)).toBeTruthy();
    expect(screen.queryByText(/WASD/)).toBeNull();
  });

  // Half the hint was unfollowable in the office a new arrival actually
  // lands in: their own, with nobody else in it. Sending somebody looking for
  // a teammate who is not there is the hint inventing a bug for them to hunt.
  it('does not send somebody in an empty office looking for a teammate', () => {
    pointerIs('fine');
    seed('owner');
    render(<HUD />);

    expect(screen.getByText('WASD or arrows to walk')).toBeTruthy();
  });

  it('mentions them once there is somebody to click', () => {
    pointerIs('fine');
    seed('owner', [], { alone: false });
    render(<HUD />);

    expect(screen.getByText(/click a teammate to peek/)).toBeTruthy();
  });

  // A tablet gains a keyboard, a convertible is folded back into a laptop.
  // Asking once at load and never again leaves the wrong instruction on
  // screen for the rest of the session.
  it('changes its mind when the pointer does', () => {
    const listeners = new Set<() => void>();
    let coarse = true;
    vi.stubGlobal('matchMedia', (media: string) => ({
      get matches() {
        return media.includes('pointer: coarse') && coarse;
      },
      media,
      addEventListener: (_: string, fn: () => void) => {
        listeners.add(fn);
      },
      removeEventListener: (_: string, fn: () => void) => {
        listeners.delete(fn);
      },
    }));
    seed('member');
    render(<HUD />);
    expect(screen.getByText(/Tap the floor to walk/)).toBeTruthy();

    act(() => {
      coarse = false;
      for (const fire of listeners) fire();
    });

    expect(screen.getByText(/WASD or arrows to walk/)).toBeTruthy();
  });

  /**
   * Somebody joined this office on 19 August, never paired a collector, and
   * was swept out by the seven-day cleanup on 3 September. For a fortnight
   * the office showed them four identical buttons and said nothing about the
   * one that mattered. This is the office saying it.
   */
  describe('the empty-avatar nudge', () => {
    const nudge = () => screen.queryByText(/nothing is sharing from your machine/);

    it('tells a member who has never paired what is missing', () => {
      seed('member');
      render(<HUD />);

      expect(nudge()).toBeTruthy();
      // And names the button rather than pointing at a corner, because the
      // buttons are a row on a laptop and a wrapped column on a phone. The
      // name in the sentence has to be the name on the button.
      const named = screen.getByText('Share agents', { selector: 'strong' });
      expect(named.textContent).toBe(
        screen.getByRole('button', { name: 'Share agents' }).textContent,
      );
    });

    it('says nothing to somebody who is already sharing', () => {
      seed('member', [], { sharing: true });
      render(<HUD />);

      expect(nudge()).toBeNull();
    });

    it(`takes "don't ask again" at its word, and keeps it`, () => {
      seed('member');
      const first = render(<HUD />);
      fireEvent.click(screen.getByRole('button', { name: "don't ask again" }));
      expect(nudge()).toBeNull();

      // A reload: same member, same browser, nothing in the store about it.
      first.unmount();
      seed('member');
      render(<HUD />);

      expect(nudge()).toBeNull();
    });

    // Sharing settles it permanently rather than merely hiding it while the
    // flag is up — otherwise the day a collector stops, the office turns
    // back into a leaflet for somebody who has been sharing for a month.
    it('never comes back once they have shared, even if sharing stops', () => {
      seed('member', [], { sharing: true });
      const first = render(<HUD />);
      first.unmount();

      seed('member', [], { sharing: false });
      render(<HUD />);

      expect(nudge()).toBeNull();
    });

    // Keyed by member, not by office: the invite code the identity is filed
    // under changes on rotation and the member id does not.
    it('is still owed to a different member on the same browser', () => {
      seed('member');
      const first = render(<HUD />);
      fireEvent.click(screen.getByRole('button', { name: "don't ask again" }));
      first.unmount();

      seed('member', [], { me: 'someone-else' });
      render(<HUD />);

      expect(nudge()).toBeTruthy();
    });
  });
});
