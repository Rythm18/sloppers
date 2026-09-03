// @vitest-environment jsdom
import type { ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { useStore } from './store.js';

/**
 * How the office and the panels over it are stacked.
 *
 * A dialog is a scrim across the whole app, so on a mouse it is obvious that
 * the office behind it cannot be clicked — the scrim is in the way. A finger
 * does not have that intuition to fall back on, and a tap that slips past a
 * dialog onto the floor sends the avatar walking out from under the thing
 * the person was reading. What actually stops it is `inert` on the scrim's
 * siblings, and the office being one of those siblings is an arrangement in
 * this file rather than a property of any component — so it is tested here.
 */

vi.mock('./game/PhaserStage.js', () => ({
  // Phaser wants a real canvas and a GPU; the arrangement under test only
  // wants an element sitting where the office sits.
  PhaserStage: () => <div className="stage" data-testid="office" aria-hidden="true" />,
}));

const net = vi.hoisted(() => ({ clearIdentity: vi.fn() }));

vi.mock('./net/socket.js', () => ({
  OfficeSocket: class {
    start(): void {}
    stop(): void {}
  },
  loadIdentity: () => null,
  clearIdentity: net.clearIdentity,
  redeemRelinkToken: async () => null,
  mintPairingCode: async () => ({ pairingCode: 'K4X-P2Q', expiresAt: Date.now() + 600_000 }),
  fetchRoomPreview: async () => null,
  sendAdmin: () => {},
  requestHistory: () => {},
}));

const world: ServerToWeb = {
  type: 'world',
  you: { memberId: 'me' },
  roomCode: 'the-lab-k4xp2q',
  roomName: 'the lab',
  members: [
    {
      id: 'me',
      displayName: 'ridham',
      avatar: 'pixel',
      role: 'owner',
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
};

describe('App', () => {
  beforeEach(() => {
    useStore.getState().reset();
    act(() => useStore.getState().applyServer(world));
  });

  afterEach(cleanup);

  it('puts the office out of reach while a dialog is open, and gives it back', async () => {
    render(<App />);
    const office = screen.getByTestId('office');
    expect(office.hasAttribute('inert')).toBe(false);

    await act(async () => {
      useStore.getState().setShareOpen(true);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(office.hasAttribute('inert')).toBe(true);

    await act(async () => {
      useStore.getState().setShareOpen(false);
    });
    expect(office.hasAttribute('inert')).toBe(false);
  });

  it('does the same for the settings panel, which opens over a live office', async () => {
    await act(async () => {
      useStore.getState().applyServer({
        type: 'workspace',
        roomCode: 'the-lab-k4xp2q',
        roomName: 'the lab',
        settings: { joinMode: 'link', publicLeaderboard: false },
      });
    });
    render(<App />);
    const office = screen.getByTestId('office');

    await act(async () => {
      useStore.getState().setSettingsOpen(true);
    });
    expect(office.hasAttribute('inert')).toBe(true);
  });

  it('puts a kicked member back at the office door, with the dead credentials forgotten', async () => {
    // "Join again" is the whole promise the card makes to the two reasons
    // that offer it. What it has to land on is the invite form for the same
    // office — not the landing page, and not a resume that would stall on
    // credentials the office no longer honours.
    net.clearIdentity.mockClear();
    await act(async () => {
      useStore.getState().applyServer({ type: 'removed', reason: 'kicked' });
    });
    render(<App />);
    expect(screen.getByText('Shown the door')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Join again' }));
    });

    expect(net.clearIdentity).toHaveBeenCalledWith('the-lab-k4xp2q');
    expect(screen.queryByText('Shown the door')).toBeNull();
    expect(screen.getByText('Your name')).toBeTruthy();
  });
});
