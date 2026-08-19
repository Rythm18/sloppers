// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendAdmin } from '../net/socket.js';
import { useStore } from '../store.js';
import { DeviceLinkModal } from './DeviceLinkModal.js';
import { qrPath } from './qr.js';

/**
 * This modal hands somebody a credential and a clock. The two things it can
 * get wrong are handing over a link that does not work anywhere but this tab,
 * and leaving a dead one on screen looking alive — so that is what these
 * tests are about.
 */

vi.mock('../net/socket.js', () => ({ sendAdmin: vi.fn() }));

const sendAdminMock = vi.mocked(sendAdmin);
const RELATIVE = '/?room=the-lab-k4xp2q#relink=0a1b2c3d4e5f60718293a4b5';
const TEN_MINUTES = 10 * 60 * 1000;

const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
const copiedText = (): string => {
  const call = writeText.mock.calls.at(-1);
  if (!call) throw new Error('nothing was copied');
  return call[0];
};

/** Put a freshly minted link in the store, the way the server would. */
function mint(ttlMs = TEN_MINUTES) {
  act(() => useStore.getState().setDeviceLink({ url: RELATIVE, expiresAt: Date.now() + ttlMs }));
}

describe('DeviceLinkModal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockClear();
    sendAdminMock.mockClear();
    useStore.getState().reset();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('stays shut until a link exists', () => {
    render(<DeviceLinkModal />);
    expect(screen.queryByRole('dialog')).toBeNull();

    mint();

    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('copies a link another device can actually open', async () => {
    render(<DeviceLinkModal />);
    mint();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });

    // The server mints it relative — it has no dependable notion of its own
    // public URL. Pasted into a phone as-is, that is not a link at all.
    expect(copiedText()).toBe(`${location.origin}${RELATIVE}`);
    expect(screen.getByText(copiedText())).toBeTruthy();
  });

  it('puts the very same string in the QR code', async () => {
    const { container } = render(<DeviceLinkModal />);
    mint();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });

    // A code that disagrees with the link beside it is worse than no code:
    // one of the two is wrong and nothing on screen says which.
    const drawn = container.querySelector('.qr path')?.getAttribute('d');
    expect(drawn).toBe(qrPath(copiedText()).path);
    expect(drawn).not.toBe(qrPath(RELATIVE).path);
  });

  it('counts down, and stops at nothing rather than going negative', () => {
    render(<DeviceLinkModal />);
    mint(90_000);
    expect(screen.getByText('expires in 1:30')).toBeTruthy();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('expires in 0:30')).toBeTruthy();

    // Well past the deadline: no negatives, and no clock at all any more.
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.queryByText(/expires in/)).toBeNull();
  });

  it('takes the dead link and its code off the screen, and says how to get another', () => {
    const { container } = render(<DeviceLinkModal />);
    mint(5_000);
    expect(container.querySelector('.qr')).toBeTruthy();

    act(() => vi.advanceTimersByTime(6_000));

    // A QR left sitting there is an invitation to scan something that has
    // already stopped working.
    expect(container.querySelector('.qr')).toBeNull();
    expect(screen.queryByText(`${location.origin}${RELATIVE}`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(screen.getByText(/That link has expired/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make a new link' }));
    expect(sendAdminMock.mock.calls.map(([op]) => op)).toEqual([{ kind: 'link-device' }]);
  });

  it('starts the clock over when a replacement link arrives', () => {
    render(<DeviceLinkModal />);
    mint(5_000);
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByText(/That link has expired/)).toBeTruthy();

    mint();

    expect(screen.getByText('expires in 10:00')).toBeTruthy();
    expect(screen.queryByText(/That link has expired/)).toBeNull();
  });

  it('closes on Escape, and puts the link away with it', () => {
    render(<DeviceLinkModal />);
    mint();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useStore.getState().deviceLink).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('puts focus inside the dialog when it opens', () => {
    render(<DeviceLinkModal />);
    mint();

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });
});
