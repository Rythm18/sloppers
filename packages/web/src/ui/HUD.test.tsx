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

function seed(role: MemberRole, knocks: KnockView[] = []): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: [
      {
        id: 'me',
        displayName: 'ridham',
        avatar: 'pixel',
        role,
        presence: 'active',
        position: { x: 0, y: 0, dir: 'down', moving: false },
        sessions: [],
        today: {
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          sessionsRun: 0,
          activeMinutes: 0,
        },
        sharing: false,
      },
    ],
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
  beforeEach(() => useStore.getState().reset());
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
});
