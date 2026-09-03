// @vitest-environment jsdom
import type { MemberView, ServerToWeb } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintPairingCode } from '../net/socket.js';
import { useStore } from '../store.js';
import { ShareModal } from './ShareModal.js';

/**
 * The first dialog a new arrival ever meets. It hand-rolled its own Escape
 * key and nothing else — no focus trap, an office still clickable behind it —
 * while the two dialogs beside it shared one implementation of all of that.
 * These tests are about it keeping the same manners they do.
 *
 * And about the thing it never did at all: notice. Pairing finishes in a
 * terminal, and this dialog sat there counting down a code that had already
 * been spent, with nothing anywhere saying it had worked.
 */

vi.mock('../net/socket.js', () => ({ mintPairingCode: vi.fn() }));

const mintMock = vi.mocked(mintPairingCode);
const ROOM = 'the-lab-k4xp2q';

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

function member(sharing: boolean): MemberView {
  return {
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
    sharing,
  };
}

/** In the office, as a member who is or is not already sharing. */
function seed(sharing = false): void {
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: ROOM,
    roomName: 'the lab',
    members: [member(sharing)],
    leaderboard: [],
  });
}

/** Open the modal and let the mint promise settle. */
async function open(): Promise<void> {
  await act(async () => {
    useStore.getState().setShareOpen(true);
  });
}

describe('ShareModal', () => {
  beforeEach(() => {
    mintMock.mockReset();
    mintMock.mockResolvedValue({
      ok: true,
      pairingCode: 'K4X-P2Q',
      expiresAt: Date.now() + 300_000,
    });
    useStore.getState().reset();
    useStore.getState().setRoomCode(ROOM);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('stays shut until the store opens it, and shuts again on Escape', async () => {
    render(<ShareModal />);
    expect(screen.queryByRole('dialog')).toBeNull();

    await open();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useStore.getState().shareOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts focus inside the dialog when it opens', async () => {
    render(<ShareModal />);
    await open();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('shows the command with the code and host already in it', async () => {
    render(<ShareModal />);
    await open();

    expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();
    expect(mintMock).toHaveBeenCalledWith(ROOM);
  });

  // A phone is where the invite gets opened and the one place the command
  // cannot be run. Printing "run this once on the machine where your agents
  // live" beside a shell command, on a device with no shell and no agents,
  // is the product not knowing where it is.
  it('sends somebody on a phone to the computer their agents are on', async () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('pointer: coarse'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<ShareModal />);
    await open();

    expect(screen.getByText(/Pairing happens on the computer your agents run on/)).toBeTruthy();
    expect(screen.queryByText(/Run this once on the machine/)).toBeNull();
    // The code still has ten minutes on it, which is long enough to get it
    // onto a laptop — so it stays offered, just not as the instruction.
    expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();
  });

  it('gives a laptop the command as the instruction it is', async () => {
    render(<ShareModal />);
    await open();

    expect(screen.getByText(/Run this once on the machine/)).toBeTruthy();
    expect(screen.queryByText(/Pairing happens on the computer/)).toBeNull();
  });

  it('mints a fresh code each time it opens rather than showing the last one', async () => {
    render(<ShareModal />);
    await open();
    act(() => useStore.getState().setShareOpen(false));

    mintMock.mockResolvedValue({
      ok: true,
      pairingCode: 'W9M-3TB',
      expiresAt: Date.now() + 300_000,
    });
    await open();

    expect(screen.getByText(`npx sloppers@latest share W9M-3TB@${location.host}`)).toBeTruthy();
    expect(screen.queryByText(/K4X-P2Q/)).toBeNull();
  });

  describe('being modal about it', () => {
    /** The modal with the office behind it, the way the app renders it. */
    function renderOverTheOffice() {
      const view = render(
        <>
          <button type="button" data-testid="behind">
            out on the floor
          </button>
          <ShareModal />
        </>,
      );
      return { ...view, behind: view.getByTestId('behind') };
    }

    it('pulls a wandering focus back in rather than letting Tab out', async () => {
      const { behind } = renderOverTheOffice();
      await open();
      const dialog = screen.getByRole('dialog');

      behind.focus();
      expect(document.activeElement).toBe(behind);

      fireEvent.keyDown(window, { key: 'Tab' });

      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it('holds focus at the far end when it wraps', async () => {
      renderOverTheOffice();
      await open();
      const dialog = screen.getByRole('dialog');
      const stops = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled])')];
      const last = stops.at(-1);
      if (!last) throw new Error('the dialog should have somewhere to put focus');

      last.focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(document.activeElement).toBe(stops[0]);

      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(last);
    });

    it('marks the office behind it inert, and hands it back on the way out', async () => {
      const { behind } = renderOverTheOffice();
      await open();

      // `aria-modal` alone tells assistive tech the background is unavailable
      // while leaving it perfectly reachable.
      expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBe('true');
      expect(behind.hasAttribute('inert')).toBe(true);

      act(() => useStore.getState().setShareOpen(false));

      expect(behind.hasAttribute('inert')).toBe(false);
    });
  });

  it('offers another go when the office could not be reached', async () => {
    mintMock.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    render(<ShareModal />);
    await open();

    expect(screen.getByText(/Could not reach the office/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();
  });

  // Both failures used to be "the server may be unreachable", including the
  // one where the server answered immediately and said no. Somebody whose
  // browser is no longer recognised — a rotated invite, cleared storage —
  // would press Try again against a server that is perfectly fine, forever.
  it('tells a refusal apart from an unreachable office', async () => {
    mintMock.mockResolvedValueOnce({ ok: false, reason: 'refused' });
    render(<ShareModal />);
    await open();

    expect(screen.getByText(/does not recognise this browser/)).toBeTruthy();
    expect(screen.getByText('sloppers relink')).toBeTruthy();
    expect(screen.queryByText(/Could not reach the office/)).toBeNull();
  });

  it('counts the code down as a clock, the way the sign-in dialog does', async () => {
    mintMock.mockResolvedValue({
      ok: true,
      pairingCode: 'K4X-P2Q',
      expiresAt: Date.now() + 600_000,
    });
    render(<ShareModal />);
    await open();

    expect(screen.getByText('code expires in 10:00')).toBeTruthy();
  });

  describe('when the pairing lands', () => {
    /** What the office sends the moment a collector attaches. */
    const collectorAttaches = () => apply({ type: 'member', member: member(true) });

    it('says so, instead of counting down a code that has been spent', async () => {
      seed(false);
      render(<ShareModal />);
      await open();
      expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();

      collectorAttaches();

      expect(screen.getByText(/your avatar is sharing/i)).toBeTruthy();
      expect(screen.queryByText(/npx sloppers@latest share/)).toBeNull();
      expect(screen.queryByText(/code expires in/)).toBeNull();
    });

    it('leaves the way out under the hand that is already there', async () => {
      seed(false);
      render(<ShareModal />);
      await open();
      collectorAttaches();

      fireEvent.click(screen.getByRole('button', { name: 'Back to the office' }));

      expect(useStore.getState().shareOpen).toBe(false);
    });

    // Somebody pairing a second laptop is already sharing when they open
    // this. Congratulating them on a pairing that happened last month — and
    // hiding the command they came here for — would be the dialog reading
    // its own state instead of what just happened.
    it('says nothing to somebody who was already sharing when they opened it', async () => {
      seed(true);
      render(<ShareModal />);
      await open();

      expect(screen.queryByText(/your avatar is sharing/i)).toBeNull();
      expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();
    });
  });
});
