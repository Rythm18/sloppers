import { CHAT_KEPT } from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from './store.js';

const baseMember = {
  id: 'm1',
  displayName: 'ridham',
  avatar: 'pixel',
  role: 'owner' as const,
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

const world = {
  type: 'world' as const,
  you: { memberId: 'm1', memberSecret: 's' },
  roomCode: 'the-lab-k4xp2q',
  roomName: 'the lab',
  members: [baseMember],
  leaderboard: [],
};

describe('store', () => {
  beforeEach(() => useStore.getState().reset());

  it('keeps workspace settings and my role from the world message', () => {
    useStore.getState().applyServer(world as never);
    expect(useStore.getState().myRole).toBe('owner');
  });

  it('stores an incoming knock queue and clears it when emptied', () => {
    useStore.getState().applyServer({
      type: 'knocks',
      knocks: [{ id: 'k1', displayName: 'sam', avatar: 'mochi', requestedAt: 1 }],
    } as never);
    expect(useStore.getState().knocks).toHaveLength(1);
    useStore.getState().applyServer({ type: 'knocks', knocks: [] } as never);
    expect(useStore.getState().knocks).toHaveLength(0);
  });

  it('records removal so the UI can explain it', () => {
    useStore.getState().applyServer({ type: 'removed', reason: 'banned' } as never);
    expect(useStore.getState().removed).toBe('banned');
  });

  it('leaves a removed user in an actionable state, not a stuck screen', () => {
    // Get into the room first, mirroring the real sequence (joined, then removed).
    useStore.getState().applyServer(world as never);
    useStore.getState().setConnection('open');
    useStore.getState().applyServer({ type: 'removed', reason: 'kicked' } as never);
    const state = useStore.getState();
    expect(state.phase).toBe('join');
    expect(state.connection).toBe('idle');
  });

  it('clears a stale removal once a fresh join succeeds', () => {
    useStore.getState().applyServer({ type: 'removed', reason: 'kicked' } as never);
    expect(useStore.getState().removed).toBe('kicked');
    useStore.getState().applyServer(world as never);
    expect(useStore.getState().removed).toBeNull();
  });

  it('updates myRole when a member upsert changes the current user role', () => {
    useStore.getState().applyServer(world as never);
    expect(useStore.getState().myRole).toBe('owner');
    useStore
      .getState()
      .applyServer({ type: 'member', member: { ...baseMember, role: 'member' } } as never);
    expect(useStore.getState().myRole).toBe('member');
  });

  it('leaves myRole alone when a different member is upserted', () => {
    useStore.getState().applyServer(world as never);
    useStore.getState().applyServer({
      type: 'member',
      member: { ...baseMember, id: 'm2', role: 'moderator' },
    } as never);
    expect(useStore.getState().myRole).toBe('owner');
  });

  it('applies workspace settings, and the office name and invite code from the workspace message', () => {
    useStore.getState().applyServer(world as never);
    useStore.getState().applyServer({
      type: 'workspace',
      roomCode: 'the-lab-9zzz1',
      roomName: 'the new lab',
      settings: { joinMode: 'knock', publicLeaderboard: true },
    } as never);
    const state = useStore.getState();
    expect(state.settings).toEqual({ joinMode: 'knock', publicLeaderboard: true });
    expect(state.roomCode).toBe('the-lab-9zzz1');
    expect(state.roomName).toBe('the new lab');
  });

  it('stores the roster from a roster message', () => {
    useStore.getState().applyServer({
      type: 'roster',
      members: [
        {
          id: 'm1',
          displayName: 'ridham',
          avatar: 'pixel',
          role: 'owner',
          status: 'active',
          sharing: false,
          lastSeenAt: 1,
        },
      ],
    } as never);
    expect(useStore.getState().roster).toHaveLength(1);
  });

  it('stores and clears a minted device link', () => {
    useStore
      .getState()
      .applyServer({ type: 'device-link', url: '/?relink=abc', expiresAt: 12345 } as never);
    expect(useStore.getState().deviceLink).toEqual({ url: '/?relink=abc', expiresAt: 12345 });
    useStore.getState().setDeviceLink(null);
    expect(useStore.getState().deviceLink).toBeNull();
  });

  it('marks knocking while waiting at the door, and clears it once let in', () => {
    useStore.getState().applyServer({ type: 'knocking' } as never);
    expect(useStore.getState().knocking).toBe(true);
    useStore.getState().applyServer(world as never);
    expect(useStore.getState().knocking).toBe(false);
  });

  it('keeps the door answer the office gave, and admits to not knowing', () => {
    // Optional on the wire. An office that never says leaves this null, and
    // the waiting screen has to claim neither thing.
    useStore.getState().applyServer({ type: 'knocking' } as never);
    expect(useStore.getState().doorAnswerable).toBeNull();

    useStore.getState().applyServer({ type: 'knocking', answerable: false } as never);
    expect(useStore.getState().doorAnswerable).toBe(false);

    // Re-sent unprompted when somebody who can answer turns up.
    useStore.getState().applyServer({ type: 'knocking', answerable: true } as never);
    expect(useStore.getState().doorAnswerable).toBe(true);

    useStore.getState().applyServer(world as never);
    expect(useStore.getState().doorAnswerable).toBeNull();
  });

  describe('refusals from inside the office', () => {
    it('keeps a refusal so the screen that asked can show it', () => {
      useStore.getState().applyServer(world as never);
      useStore
        .getState()
        .applyServer({ type: 'error', code: 'forbidden', message: 'they outrank you' } as never);
      expect(useStore.getState().adminError).toBe('they outrank you');
      // The refusal is about one op, not about being in the office — nothing
      // else moves, or a refused ban would throw everybody back to the form.
      expect(useStore.getState().phase).toBe('world');
      expect(useStore.getState().connection).toBe('open');
    });

    it('leaves join-time errors on the join screen where they belong', () => {
      useStore
        .getState()
        .applyServer({ type: 'error', code: 'name-taken', message: 'already called sam' } as never);
      const state = useStore.getState();
      expect(state.joinError).toBe('already called sam');
      expect(state.adminError).toBeNull();
    });

    it('drops a refusal when a fresh join lands', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setAdminError('they outrank you');
      useStore.getState().applyServer(world as never);
      expect(useStore.getState().adminError).toBeNull();
    });
  });

  /**
   * Every one of these used to leave `connecting` in place, which is the
   * submit button reading "Stepping in…" for as long as the tab is open.
   * They are listed one by one because each is a shape somebody can actually
   * arrive in, not because the store branches on them separately — it no
   * longer does, and that is the fix.
   */
  describe('refusals at the door', () => {
    const refused = (code: string, message: string) =>
      useStore.getState().applyServer({ type: 'error', code, message } as never);

    it('says what a locked office really means, including that knocking is out', () => {
      // The office's own sentence stops at "not accepting new people", which
      // leaves the obvious next move — knock, wait — sounding available.
      useStore.getState().setConnection('connecting');
      refused('workspace-locked', 'this office is not accepting new people right now');

      const state = useStore.getState();
      expect(state.joinError).toMatch(/closed to new people/);
      expect(state.joinError).toMatch(/knocking is not an option/);
      expect(state.connection).toBe('idle');
      expect(state.phase).toBe('join');
    });

    it('re-enables the form when the office rate-limits the join itself', () => {
      // `bad-message` reaches the door through the per-connection limiter,
      // which is spent before the join is even looked at.
      useStore.getState().setConnection('connecting');
      refused('bad-message', 'slow down');

      expect(useStore.getState().joinError).toBe('slow down');
      expect(useStore.getState().connection).toBe('idle');
    });

    it('takes a denied knocker off the waiting screen so they can read the answer', () => {
      useStore.getState().applyServer({ type: 'knocking', answerable: true } as never);
      refused('forbidden', 'nobody let you in this time');

      const state = useStore.getState();
      expect(state.knocking).toBe(false);
      expect(state.joinError).toBe('nobody let you in this time');
      expect(state.connection).toBe('idle');
    });

    it('reads a refused reconnect as the door, not as a refused click', () => {
      // `phase` still says 'world' while a reconnect is in flight — we were
      // in there a second ago. Judging by phase alone filed a dead resume as
      // an admin refusal, leaving somebody looking at an office they had
      // already been removed from with an odd note in a panel.
      useStore.getState().applyServer(world as never);
      useStore.getState().setConnection('reconnecting');

      refused('bad-join', 'unknown member');

      const state = useStore.getState();
      expect(state.adminError).toBeNull();
      expect(state.joinError).toBe('unknown member');
      expect(state.phase).toBe('join');
      expect(state.connection).toBe('idle');
    });
  });

  it('toggles the settings panel', () => {
    expect(useStore.getState().settingsOpen).toBe(false);
    useStore.getState().setSettingsOpen(true);
    expect(useStore.getState().settingsOpen).toBe(true);
  });

  it('resets every field the store tracks, including the new workspace fields', () => {
    useStore.getState().applyServer(world as never);
    useStore.getState().applyServer({ type: 'knocking', answerable: true } as never);
    useStore.getState().applyServer({
      type: 'workspace',
      roomCode: 'x-1',
      roomName: 'x',
      settings: { joinMode: 'locked', publicLeaderboard: true },
    } as never);
    useStore.getState().applyServer({
      type: 'roster',
      members: [
        {
          id: 'm1',
          displayName: 'ridham',
          avatar: 'pixel',
          role: 'owner',
          status: 'active',
          sharing: false,
          lastSeenAt: 1,
        },
      ],
    } as never);
    useStore
      .getState()
      .applyServer({ type: 'device-link', url: '/?relink=abc', expiresAt: 1 } as never);
    useStore.getState().applyServer({ type: 'removed', reason: 'deleted' } as never);
    useStore.getState().setSettingsOpen(true);
    useStore.getState().setAdminError('they outrank you');

    useStore.getState().reset();

    const state = useStore.getState();
    expect(state.phase).toBe('join');
    expect(state.connection).toBe('idle');
    expect(state.roomCode).toBe('');
    expect(state.roomName).toBe('');
    expect(state.you).toBeNull();
    expect(state.members).toEqual({});
    expect(state.myRole).toBeNull();
    expect(state.settings).toBeNull();
    expect(state.knocks).toEqual([]);
    expect(state.roster).toEqual([]);
    expect(state.deviceLink).toBeNull();
    expect(state.removed).toBeNull();
    expect(state.knocking).toBe(false);
    expect(state.doorAnswerable).toBeNull();
    expect(state.settingsOpen).toBe(false);
    expect(state.adminError).toBeNull();
    expect(state.chat).toEqual([]);
    expect(state.chatUnread).toBe(0);
    expect(state.chatUnreadSince).toBeNull();
    expect(state.chatError).toBeNull();
  });

  const history = {
    type: 'history' as const,
    days: ['2026-09-04', '2026-09-03'],
    members: [
      {
        memberId: 'm1',
        displayName: 'ridham',
        avatar: 'pixel',
        days: [
          {
            day: '2026-09-04',
            stats: {
              tokens: { input: 500, output: 0, cacheRead: 0, cacheWrite: 0 },
              sessionsRun: 1,
              activeMinutes: 3,
            },
          },
        ],
      },
    ],
  };

  it('keeps the office history it was handed', () => {
    useStore.getState().applyServer(history);
    expect(useStore.getState().history?.days).toEqual(['2026-09-04', '2026-09-03']);
    expect(useStore.getState().historyPending).toBe(false);
  });

  it('drops history on a fresh world, which may be a fresh day', () => {
    // A tab left open past midnight resumes into an office whose "today" has
    // moved. Every key in the old answer is off by one, and carrying it would
    // put yesterday's label on the day before it.
    useStore.getState().applyServer(history);
    useStore.getState().setBoardDay(1);
    useStore.getState().applyServer(world as never);

    expect(useStore.getState().history).toBeNull();
    expect(useStore.getState().boardDay).toBe(0);
  });

  it('releases a waiting history request when the office refuses something', () => {
    // The wire cannot say which answerable message an error is about, so a
    // pending request is released either way — the alternative is a board
    // reading "fetching…" until the tab is reloaded.
    useStore.getState().applyServer(world as never);
    useStore.getState().setConnection('open');
    useStore.getState().setHistoryPending(true);
    useStore.getState().applyServer({ type: 'error', code: 'bad-message', message: 'slow down' });

    expect(useStore.getState().historyPending).toBe(false);
    expect(useStore.getState().adminError).toBe('slow down');
  });

  describe('the conversation', () => {
    const line = (id: string, memberId: string, at: number, text = id) => ({
      id,
      memberId,
      displayName: memberId,
      text,
      at,
    });

    /** In the office, connected, with the panel shut — the unread case. */
    function inTheOfficeWithChatShut(): void {
      useStore.getState().applyServer(world as never);
      useStore.getState().setConnection('open');
      useStore.getState().setChatOpen(false);
    }

    it('takes the backlog the office hands over and the mark that came with it', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setChatOpen(false);
      useStore.getState().applyServer({
        type: 'chat-log',
        messages: [line('a', 'nina', 100), line('b', 'nina', 200)],
        unreadSince: 200,
      } as never);

      const state = useStore.getState();
      expect(state.chat.map((m) => m.id)).toEqual(['a', 'b']);
      expect(state.chatUnreadSince).toBe(200);
      expect(state.chatUnread).toBe(1);
    });

    it('announces nothing on a backlog that missed nothing', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setChatOpen(false);
      useStore
        .getState()
        .applyServer({ type: 'chat-log', messages: [line('a', 'nina', 100)] } as never);

      expect(useStore.getState().chatUnread).toBe(0);
      expect(useStore.getState().chatUnreadSince).toBeNull();
    });

    it('counts a missed line, and never one of your own', () => {
      inTheOfficeWithChatShut();
      useStore.getState().applyServer({ type: 'chat', message: line('a', 'nina', 100) } as never);
      expect(useStore.getState().chatUnread).toBe(1);

      // `m1` is this browser. Its own message coming back is the office
      // confirming the sentence landed, which is not news to announce.
      useStore.getState().applyServer({ type: 'chat', message: line('b', 'm1', 200) } as never);
      expect(useStore.getState().chatUnread).toBe(1);
      expect(useStore.getState().chat).toHaveLength(2);
    });

    it('counts nothing while the panel is open, and opening it clears the count', () => {
      inTheOfficeWithChatShut();
      useStore.getState().applyServer({ type: 'chat', message: line('a', 'nina', 100) } as never);
      useStore.getState().setChatOpen(true);
      expect(useStore.getState().chatUnread).toBe(0);

      useStore.getState().applyServer({ type: 'chat', message: line('b', 'nina', 200) } as never);
      expect(useStore.getState().chatUnread).toBe(0);
    });

    it('keeps the mark until somebody answers, not merely until they look', () => {
      // On a laptop the panel is already open when the backlog arrives, so
      // clearing the mark on open would mean nobody with a wide screen ever
      // saw where they stopped reading.
      useStore.getState().applyServer(world as never);
      useStore.getState().applyServer({
        type: 'chat-log',
        messages: [line('a', 'nina', 100)],
        unreadSince: 100,
      } as never);
      useStore.getState().setChatOpen(true);
      expect(useStore.getState().chatUnreadSince).toBe(100);

      useStore.getState().chatCaughtUp();
      expect(useStore.getState().chatUnreadSince).toBeNull();
    });

    it('never holds more than the office itself keeps', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setChatOpen(true);
      for (let i = 0; i < CHAT_KEPT + 20; i++) {
        useStore
          .getState()
          .applyServer({ type: 'chat', message: line(`c${i}`, 'nina', 1000 + i) } as never);
      }
      const chat = useStore.getState().chat;
      expect(chat).toHaveLength(CHAT_KEPT);
      // The end of the conversation, not the start: a tab open for a week
      // shows what the office would hand back on the next visit.
      expect(chat.at(-1)?.id).toBe(`c${CHAT_KEPT + 19}`);
    });

    it('drops a line the office took down, and leaves the rest alone', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().applyServer({
        type: 'chat-log',
        messages: [line('a', 'nina', 100), line('b', 'nina', 200)],
      } as never);
      useStore.getState().applyServer({ type: 'chat-removed', id: 'a' } as never);

      expect(useStore.getState().chat.map((m) => m.id)).toEqual(['b']);
    });

    /**
     * The routing this whole error code exists for. Every other refusal inside
     * an open office answers a click on a control, and lands beside it. A
     * refused chat message answers a sentence in a text box — put it in the
     * admin channel and the person typing watches nothing happen, possibly
     * with the panel holding their answer closed.
     */
    it('puts a refused message in the chat’s own channel, not the admin panel', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setConnection('open');
      useStore.getState().applyServer({
        type: 'error',
        code: 'chat-refused',
        message: 'easy — the office is catching up',
      } as never);

      const state = useStore.getState();
      expect(state.chatError).toBe('easy — the office is catching up');
      expect(state.adminError).toBeNull();
      // And it is not about being in the office: a refused line must not throw
      // somebody back to the join form.
      expect(state.phase).toBe('world');
    });

    it('leaves a waiting history request alone when chat is what was refused', () => {
      // The blanket release above exists because the wire cannot say which
      // answerable message an error is about. This one can.
      useStore.getState().applyServer(world as never);
      useStore.getState().setConnection('open');
      useStore.getState().setHistoryPending(true);
      useStore
        .getState()
        .applyServer({ type: 'error', code: 'chat-refused', message: 'nothing in that' } as never);

      expect(useStore.getState().historyPending).toBe(true);
    });

    it('empties the conversation on a fresh world without closing the panel', () => {
      useStore.getState().applyServer(world as never);
      useStore.getState().setChatOpen(true);
      useStore
        .getState()
        .applyServer({ type: 'chat-log', messages: [line('a', 'nina', 100)] } as never);
      useStore.getState().setChatError('nothing in that');

      // A reconnect: the office's own `chat-log` is right behind this, and it
      // may have been trimmed or deleted from while we were gone.
      useStore.getState().applyServer(world as never);
      const state = useStore.getState();
      expect(state.chat).toEqual([]);
      expect(state.chatError).toBeNull();
      expect(state.chatUnread).toBe(0);
      // But the panel somebody is reading stays open across a dropped socket.
      expect(state.chatOpen).toBe(true);
    });
  });
});

/**
 * On a laptop the board sits in the margin beside the office. On a phone
 * there is no margin, so it arrives as a sheet across half the floor — which
 * is the wrong first thing for somebody who just followed an invite to see,
 * particularly when it will be reading "no tokens burned yet today".
 *
 * Read at load rather than watched, so `reset()` gives back the same answer
 * the tab opened with. These re-import the module to catch it being read.
 */
describe('the board on arrival', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Answer every media query the same way, whatever it asks. */
  function screenSays(matches: boolean): void {
    vi.stubGlobal('matchMedia', (media: string) => ({ matches, media }));
  }

  it('is open where there is room beside the office', async () => {
    screenSays(false);
    vi.resetModules();
    const store = await import('./store.js');

    expect(store.useStore.getState().leaderboardOpen).toBe(true);
  });

  it('is shut where it would cover the office it is about', async () => {
    screenSays(true);
    vi.resetModules();
    const store = await import('./store.js');

    expect(store.useStore.getState().leaderboardOpen).toBe(false);
    // And still shut after a reset, which is how somebody who was removed
    // comes back in.
    store.useStore.getState().reset();
    expect(store.useStore.getState().leaderboardOpen).toBe(false);
  });

  /**
   * Chat answers the same question the same way, and for a stronger reason:
   * the panel carries a text field, so on a phone it arrives with a keyboard
   * over the room. The button in the HUD wears the dot when somebody speaks.
   */
  it('takes chat with it: open beside the office, shut where it would cover it', async () => {
    screenSays(false);
    vi.resetModules();
    expect((await import('./store.js')).useStore.getState().chatOpen).toBe(true);

    screenSays(true);
    vi.resetModules();
    const narrow = await import('./store.js');
    expect(narrow.useStore.getState().chatOpen).toBe(false);
    narrow.useStore.getState().reset();
    expect(narrow.useStore.getState().chatOpen).toBe(false);
  });
});
