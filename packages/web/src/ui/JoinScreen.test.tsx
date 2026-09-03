// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRoomPreview } from '../net/socket.js';
import { useStore } from '../store.js';
import { JoinScreen } from './JoinScreen.js';

/**
 * The front door, and the two ways it used to be possible to stand outside it
 * pressing a button that did nothing at all: an empty office name, and an
 * invite that has died since it was sent. Both ended in the same place — a
 * submit handler that returned without a word — so both are about what the
 * form decides, not about what it looks like.
 */

vi.mock('../net/socket.js', () => ({ fetchRoomPreview: vi.fn() }));

const previewMock = vi.mocked(fetchRoomPreview);
const ROOM = 'the-lab-k4xp2q';

const handlers = {
  onCreate: vi.fn(),
  onJoin: vi.fn(),
  onFollowInvite: vi.fn(),
  onGiveUpKnocking: vi.fn(),
};

/**
 * Render and let the invite preview settle, since which shape the form takes
 * is the preview's answer.
 */
async function show(invitedRoom: string | null = null): Promise<void> {
  await act(async () => {
    render(
      <JoinScreen invitedRoom={invitedRoom} resuming={false} connecting={false} {...handlers} />,
    );
  });
}

const type = (label: RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/**
 * Submit the form itself rather than clicking the button. `required` makes
 * the browser refuse an untouched field before any of this runs, which is the
 * better answer and not the one under test here — what these tests are about
 * is the handler behind it, which is all that stands between a person and
 * silence once `required` is satisfied.
 */
const submit = () => {
  const form = document.querySelector('form');
  if (!form) throw new Error('expected the join form to be on screen');
  fireEvent.submit(form);
};

describe('JoinScreen', () => {
  beforeEach(() => {
    previewMock.mockReset();
    previewMock.mockResolvedValue({ name: 'the lab', memberCount: 3 });
    for (const handler of Object.values(handlers)) handler.mockReset();
    useStore.getState().reset();
  });

  afterEach(cleanup);

  it('answers a blank office name instead of swallowing the press', async () => {
    await show();
    type(/your name/i, 'ridham');

    submit();

    expect(handlers.onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/Give the office a name/)).toBeTruthy();
  });

  it('answers a name that is only spaces, which `required` lets through', async () => {
    await show();
    type(/office name/i, 'the lab');
    type(/your name/i, '   ');

    submit();

    expect(handlers.onCreate).not.toHaveBeenCalled();
    expect(screen.getByText(/something to call you/)).toBeTruthy();
  });

  it('asks the browser for the fields before anything is typed', async () => {
    // The message above is the safety net; this is the affordance that points
    // at the field somebody left empty.
    await show();
    expect(screen.getByLabelText(/office name/i).hasAttribute('required')).toBe(true);
    expect(screen.getByLabelText(/your name/i).hasAttribute('required')).toBe(true);
  });

  it('clears its objection as soon as the field is being fixed', async () => {
    await show();
    type(/your name/i, 'ridham');
    submit();
    expect(screen.getByText(/Give the office a name/)).toBeTruthy();

    type(/office name/i, 't');

    expect(screen.queryByText(/Give the office a name/)).toBeNull();
  });

  it('creates an office when the invite is dead, rather than re-offering the dead code', async () => {
    // The screen already says "start your own below" and shows the office
    // name field. Submitting used to send the dead code back to the office
    // anyway, so the button failed the same way every time it was pressed.
    previewMock.mockResolvedValue(null);
    await show(ROOM);
    expect(screen.getByRole('button', { name: 'Create office' })).toBeTruthy();

    type(/office name/i, 'my own lab');
    type(/your name/i, 'ridham');
    submit();

    expect(handlers.onJoin).not.toHaveBeenCalled();
    expect(handlers.onCreate).toHaveBeenCalledWith('my own lab', 'ridham', expect.any(String));
  });

  it('still steps into an invite that is alive', async () => {
    await show(ROOM);
    expect(screen.getByRole('button', { name: 'Step in' })).toBeTruthy();

    type(/your name/i, 'ridham');
    submit();

    expect(handlers.onCreate).not.toHaveBeenCalled();
    expect(handlers.onJoin).toHaveBeenCalledWith(ROOM, 'ridham', expect.any(String));
  });

  it('shows the office an answer it gave, once there is nothing left to correct', async () => {
    await show(ROOM);
    act(() => useStore.getState().setJoinError('someone here is already called ridham'));
    expect(screen.getByText(/already called ridham/)).toBeTruthy();
  });

  /**
   * An invite link is how nearly everybody meets sloppers, and it skips the
   * landing page entirely — `App` renders that only when there is no `?room=`.
   * The one sentence saying what the product is used to live in the branch
   * for people who arrived without an invite, so the person the door was
   * built for was the only one who never read it.
   */
  describe('saying what this is', () => {
    const explains = () => screen.queryByText(/pixel office where your team/i);

    it('tells an invitee what they have been invited to', async () => {
      await show(ROOM);

      expect(screen.getByText(/You’re invited to/)).toBeTruthy();
      expect(explains()).toBeTruthy();
    });

    it('tells somebody holding a dead invite too, since they are about to make one', async () => {
      previewMock.mockResolvedValue(null);
      await show(ROOM);

      expect(explains()).toBeTruthy();
    });

    /**
     * Rotating the invite is the ordinary way a link dies, and it takes
     * nobody's seat with it — the credentials in a browser name the office by
     * themselves. A member who reads "this invite doesn't point to an office
     * anymore" and nothing else has been told their office is gone, which is
     * both untrue and the one thing they will act on.
     */
    it('says what a dead link actually costs, which is not the seat behind it', async () => {
      previewMock.mockResolvedValue(null);
      await show(ROOM);

      const tagline = screen.getByText(/doesn’t point to an office anymore/);
      expect(tagline.textContent).toMatch(/link was rotated/);
      expect(tagline.textContent).toMatch(/still yours/);
      expect(tagline.textContent).toMatch(/browser you last used gets you back in/);
    });

    it('offers the browser as a way back, not only a paired machine', async () => {
      // The office refuses a member their own name at a rotated door, and the
      // only remedy offered used to be a collector — which the people this
      // catches are exactly the people who do not have one.
      await show(ROOM);
      act(() => {
        useStore.getState().setJoinError('someone here is already called ridham');
      });

      const hint = screen.getByText(/Was that you\?/);
      expect(hint.textContent).toMatch(/browser you last used/);
      expect(hint.textContent).toMatch(/sloppers relink/);
    });

    it('says it once, not twice, while the invite is still being looked up', async () => {
      // Mid-lookup the greeting has nothing to greet with, so the tagline is
      // already the headline — and a second copy of it underneath reads as a
      // rendering fault.
      previewMock.mockReturnValue(new Promise(() => {}));
      await show(ROOM);

      expect(screen.getAllByText(/pixel office where your team/i)).toHaveLength(1);
    });
  });
});
