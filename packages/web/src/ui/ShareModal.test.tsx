// @vitest-environment jsdom
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
 */

vi.mock('../net/socket.js', () => ({ mintPairingCode: vi.fn() }));

const mintMock = vi.mocked(mintPairingCode);
const ROOM = 'the-lab-k4xp2q';

/** Open the modal and let the mint promise settle. */
async function open(): Promise<void> {
  await act(async () => {
    useStore.getState().setShareOpen(true);
  });
}

describe('ShareModal', () => {
  beforeEach(() => {
    mintMock.mockReset();
    mintMock.mockResolvedValue({ pairingCode: 'K4X-P2Q', expiresAt: Date.now() + 300_000 });
    useStore.getState().reset();
    useStore.getState().setRoomCode(ROOM);
  });

  afterEach(cleanup);

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

  it('mints a fresh code each time it opens rather than showing the last one', async () => {
    render(<ShareModal />);
    await open();
    act(() => useStore.getState().setShareOpen(false));

    mintMock.mockResolvedValue({ pairingCode: 'W9M-3TB', expiresAt: Date.now() + 300_000 });
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

  it('offers another go when the server would not mint a code', async () => {
    mintMock.mockResolvedValueOnce(null);
    render(<ShareModal />);
    await open();

    expect(screen.getByText(/Could not mint a code/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    expect(screen.getByText(`npx sloppers@latest share K4X-P2Q@${location.host}`)).toBeTruthy();
  });
});
