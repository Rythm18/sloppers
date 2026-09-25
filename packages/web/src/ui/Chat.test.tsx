// @vitest-environment jsdom
import type { ChatMessage, MemberRole, ServerToWeb } from '@sloppers/protocol';
import { MAX_CHAT_LENGTH } from '@sloppers/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTypingSomewhere } from '../game/typing.js';
import { useStore } from '../store.js';
import { Chat } from './Chat.js';

/**
 * The panel, and the two things about it that are not like any other panel in
 * the office: it renders text somebody else wrote, and it holds a text field
 * over a game canvas that watches the keyboard.
 */

const sent: string[] = [];
const ops: unknown[] = [];

vi.mock('../net/socket.js', () => ({
  sendChat: (text: string) => sent.push(text),
  sendAdmin: (op: unknown) => ops.push(op),
}));

const apply = (msg: ServerToWeb) => act(() => useStore.getState().applyServer(msg));

function member(id: string, role: MemberRole) {
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
    sharing: false,
  };
}

function line(id: string, memberId: string, text: string, at = 1_700_000_000_000): ChatMessage {
  return { id, memberId, displayName: memberId, text, at };
}

/** In the office as `me`, with the panel open and whatever has been said. */
function seed(messages: ChatMessage[], role: MemberRole = 'member'): void {
  useStore.getState().reset();
  apply({
    type: 'world',
    you: { memberId: 'me' },
    roomCode: 'the-lab-k4xp2q',
    roomName: 'the lab',
    members: [member('me', role), member('nina', 'member')],
    leaderboard: [],
  });
  act(() => useStore.getState().setChatOpen(true));
  if (messages.length > 0) apply({ type: 'chat-log', messages });
}

describe('Chat', () => {
  beforeEach(() => {
    sent.length = 0;
    ops.length = 0;
  });
  afterEach(cleanup);

  it('shows nothing at all while it is shut', () => {
    seed([line('a', 'nina', 'hello')]);
    act(() => useStore.getState().setChatOpen(false));
    render(<Chat />);
    expect(screen.queryByLabelText('office chat')).toBeNull();
  });

  /**
   * The mutation guard for the one genuinely dangerous thing chat does: it
   * broadcasts something one person wrote to everybody else's browser.
   *
   * React escapes text by default, so the fix is to never leave that path —
   * no raw-HTML escape hatch, no markdown, no linkifier. Rendering the markup
   * as an element instead of as characters has to fail here.
   */
  it('renders markup as the characters somebody typed, never as markup', () => {
    const nasty = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    seed([line('a', 'nina', nasty)]);
    const { container } = render(<Chat />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // And it is all still there, exactly as written — the office does not
    // quietly rewrite what somebody said either.
    expect(container.querySelector('.chat-text')?.textContent).toBe(nasty);
  });

  it('shows who said what, and stops repeating a name down one person’s turn', () => {
    seed([
      line('a', 'nina', 'first', 1_000_000),
      line('b', 'nina', 'second', 1_000_500),
      // Five minutes later: a new thought, and it carries the name again.
      line('c', 'nina', 'third', 1_300_500),
      line('d', 'me', 'mine', 1_300_600),
    ]);
    const { container } = render(<Chat />);

    const names = [...container.querySelectorAll('.chat-who')].map((el) => el.textContent);
    expect(names).toEqual(['nina', 'nina', 'me']);
    expect([...container.querySelectorAll('.chat-text')].map((el) => el.textContent)).toEqual([
      'first',
      'second',
      'third',
      'mine',
    ]);
  });

  it('draws the rule where somebody stopped reading, and only there', () => {
    seed([]);
    apply({
      type: 'chat-log',
      messages: [line('a', 'nina', 'seen', 100), line('b', 'nina', 'missed', 200)],
      unreadSince: 200,
    });
    const { container } = render(<Chat />);
    expect(container.querySelectorAll('.chat-mark')).toHaveLength(1);
  });

  it('sends what the office would store, and clears the box', () => {
    seed([]);
    render(<Chat />);
    const input = screen.getByLabelText('say something to the office');

    // A single-line field strips line breaks for us, which is half of why
    // this is one — the collapse in `normalizeChatText` is what catches the
    // rest, and a client that is not this one.
    fireEvent.change(input, { target: { value: '  shipped   it  ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    // Flattened by the same function the server flattens with, so a browser
    // never shows a draft it would have to hear back differently.
    expect(sent).toEqual(['shipped it']);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('will not send a message with nothing in it', () => {
    seed([]);
    render(<Chat />);
    const input = screen.getByLabelText('say something to the office');
    const say = screen.getByRole('button', { name: 'Say' }) as HTMLButtonElement;

    expect(say.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '   ' } });
    expect(say.disabled).toBe(true);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(sent).toEqual([]);

    fireEvent.change(input, { target: { value: 'ok' } });
    expect(say.disabled).toBe(false);
  });

  it('caps the box itself, so nobody can reach the wire’s refusal', () => {
    seed([]);
    render(<Chat />);
    const input = screen.getByLabelText('say something to the office') as HTMLInputElement;
    expect(input.maxLength).toBe(MAX_CHAT_LENGTH);

    // And says how much is left only once it is close enough to matter.
    fireEvent.change(input, { target: { value: 'x'.repeat(10) } });
    expect(screen.queryByText(/left$/)).toBeNull();
    fireEvent.change(input, { target: { value: 'x'.repeat(MAX_CHAT_LENGTH - 5) } });
    expect(screen.getByText('5 left')).toBeTruthy();
  });

  /**
   * Phaser watches the keyboard at the window, so w, a, s and d reach the
   * office from wherever they were typed. The office solved this twice — the
   * scene registers its keys with capture off, and `keyHeading` refuses to
   * move anything while a field has focus — and this is a plain `<input>`
   * precisely so both of those keep working. A textarea, a contenteditable or
   * a hand-rolled key handler would all need it solving a third time.
   */
  it('is a field the office already knows not to walk on', () => {
    seed([]);
    render(<Chat />);
    const input = screen.getByLabelText('say something to the office') as HTMLInputElement;

    expect(isTypingSomewhere()).toBe(false);
    input.focus();
    expect(isTypingSomewhere()).toBe(true);

    // Escape hands the floor back, which is the only way off the field on a
    // laptop that does not involve finding somewhere else to click.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(isTypingSomewhere()).toBe(false);
  });

  it('shows the office’s refusal beside the box, and drops it on the next keystroke', () => {
    seed([]);
    render(<Chat />);
    act(() => useStore.getState().setChatError('easy — the office is catching up'));
    expect(screen.getByText('easy — the office is catching up')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('say something to the office'), {
      target: { value: 'again' },
    });
    expect(screen.queryByText('easy — the office is catching up')).toBeNull();
  });

  describe('taking a line down', () => {
    it('offers it on your own message and on nobody else’s', () => {
      seed([line('a', 'nina', 'theirs'), line('b', 'me', 'mine')], 'member');
      render(<Chat />);

      expect(screen.queryByLabelText("delete nina's message")).toBeNull();
      expect(screen.getByLabelText("delete me's message")).toBeTruthy();
    });

    it('offers it on anybody’s message to somebody who moderates', () => {
      seed([line('a', 'nina', 'theirs')], 'moderator');
      render(<Chat />);

      fireEvent.click(screen.getByLabelText("delete nina's message"));
      expect(ops).toEqual([{ kind: 'chat-delete', messageId: 'a' }]);
    });
  });
});
