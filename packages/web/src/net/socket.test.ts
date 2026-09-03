import type { AdminOp } from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../store.js';
import { type JoinIntent, loadIdentity, OfficeSocket, sendAdmin } from './socket.js';

/**
 * `OfficeSocket` talks to real browser globals (WebSocket, window, document,
 * localStorage) that don't exist in vitest's default node environment.
 * These are the minimal stand-ins needed to drive `start()` through a real
 * connect/open/message/close cycle without a jsdom dependency.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Test helper: simulate the connection completing. */
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** Test helper: simulate a server message. */
  triggerMessage(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Test helper: simulate the server (or network) closing the socket. */
  triggerClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const storageData = new Map<string, string>();
const fakeLocalStorage = {
  getItem: (key: string) => storageData.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageData.set(key, value);
  },
  removeItem: (key: string) => {
    storageData.delete(key);
  },
};

// biome-ignore lint/suspicious/noExplicitAny: minimal browser-global shims for a node test environment
(globalThis as any).WebSocket = FakeWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).location = { protocol: 'http:', host: 'localhost' };
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).window = {
  setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  addEventListener: () => {},
  removeEventListener: () => {},
};
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
};
// biome-ignore lint/suspicious/noExplicitAny: same
(globalThis as any).localStorage = fakeLocalStorage;

/** The office's answer to a join that worked, for a member it just minted. */
const WORLD = {
  type: 'world' as const,
  you: { memberId: 'm1', memberSecret: 's3cret' },
  roomCode: 'the-lab-k4xp2q',
  roomName: 'the lab',
  members: [],
  leaderboard: [],
};

const CREATE: JoinIntent = {
  kind: 'create',
  roomName: 'test office',
  displayName: 'ridham',
  avatar: 'pixel',
};

const INVITED: JoinIntent = {
  kind: 'invited',
  roomCode: 'the-lab-k4xp2q',
  displayName: 'ridham',
  avatar: 'pixel',
};

/** The code an office moves to when its owner rotates the invite. */
const ROTATED = 'the-lab-9zzz1r';

/** The office's own state, which is what a rotation arrives as. */
const workspaceAt = (roomCode: string) => ({
  type: 'workspace' as const,
  roomCode,
  roomName: 'the lab',
  settings: { joinMode: 'link' as const, publicLeaderboard: false },
});

describe('OfficeSocket', () => {
  let socket: OfficeSocket | null = null;

  beforeEach(() => {
    useStore.getState().reset();
    FakeWebSocket.instances.length = 0;
    storageData.clear();
  });

  afterEach(() => {
    socket?.stop();
    socket = null;
    vi.useRealTimers();
  });

  /** The socket most recently handed to `connect()`. */
  function latest(): FakeWebSocket {
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('expected a socket to have been created');
    return ws;
  }

  /** The first thing a connection says, which is always its `join`. */
  function joinSentOn(ws: FakeWebSocket): unknown {
    const [first] = ws.sent;
    if (!first) throw new Error('expected a join to have been sent');
    return JSON.parse(first);
  }

  function start(intent: JoinIntent): FakeWebSocket {
    socket = new OfficeSocket(intent);
    socket.start();
    const ws = latest();
    ws.triggerOpen();
    return ws;
  }

  /**
   * Drop the live connection and let the backoff elapse, which is what a
   * wifi blip or a Fly cold start looks like from in here. The base backoff
   * is 800ms with jitter, so a second covers it.
   */
  function dropAndReconnect(ws: FakeWebSocket): FakeWebSocket {
    ws.triggerClose();
    vi.advanceTimersByTime(1000);
    const next = latest();
    next.triggerOpen();
    return next;
  }

  function startAndOpen(): FakeWebSocket {
    const ws = start(CREATE);
    ws.sent.length = 0; // discard the join message; tests only care about what comes after
    return ws;
  }

  it('sendAdmin forwards the op to the live connection, so UI never touches the socket', () => {
    const ws = startAndOpen();
    const op: AdminOp = { kind: 'roster' };

    sendAdmin(op);

    expect(ws.sent).toHaveLength(1);
    const [sent] = ws.sent;
    if (!sent) throw new Error('expected a message to have been sent');
    expect(JSON.parse(sent)).toEqual({ type: 'admin', op });
  });

  it('sendAdmin is a no-op once the socket has stopped', () => {
    const ws = startAndOpen();
    socket?.stop();

    sendAdmin({ kind: 'roster' });

    expect(ws.sent).toHaveLength(0);
  });

  it('closes the connection on stop, which is what takes a knocker off the door', () => {
    // Giving up at the door has no message of its own: the office drops the
    // knock in its socket close handler and pushes the shortened queue. So
    // the whole withdrawal rests on `stop()` really closing, and on it not
    // reconnecting afterwards and rejoining the queue.
    const ws = startAndOpen();

    socket?.stop();

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    const opened = FakeWebSocket.instances.length;
    ws.triggerClose();
    expect(FakeWebSocket.instances).toHaveLength(opened);
  });

  it('leaves the connection state alone after removal, instead of reopening a reconnect loop', () => {
    const ws = startAndOpen();

    ws.triggerMessage({ type: 'removed', reason: 'banned' });
    expect(useStore.getState().connection).toBe('idle');

    // The server closes the socket right after telling us we're removed —
    // this used to flip the store back to 'reconnecting' and schedule a
    // retry with now-invalid credentials.
    ws.triggerClose();

    expect(useStore.getState().connection).toBe('idle');
    expect(useStore.getState().removed).toBe('banned');
    expect(useStore.getState().phase).toBe('join');
  });

  /**
   * A reconnect is not a second arrival. Once the office has answered with a
   * `world`, this browser is a particular member of a particular office, and
   * the only thing a dropped socket should do is put that member back — never
   * re-run the errand that got them in, which the office would answer as if a
   * stranger had walked up.
   */
  describe('what a reconnect asks the office for', () => {
    beforeEach(() => vi.useFakeTimers());

    it('resumes the office it created instead of opening a second one', () => {
      // The tab that created an office keeps a `create` intent. Replayed on a
      // reconnect, the server has no credentials to read, takes the create
      // branch, and mints a whole new office — leaving the real one, and
      // everyone invited to it, behind a URL this tab no longer points at.
      const first = start(CREATE);
      expect(joinSentOn(first)).toMatchObject({ createRoom: 'test office' });
      first.triggerMessage(WORLD);

      const second = dropAndReconnect(first);

      expect(joinSentOn(second)).toEqual({
        type: 'join',
        memberId: 'm1',
        memberSecret: 's3cret',
      });
    });

    it('resumes an invited seat instead of offering its own name back', () => {
      // Replaying an `invited` intent asks for a name the office has already
      // handed to this very member, so it answers `name-taken` — accusing
      // somebody of being someone else, over their own name.
      const first = start(INVITED);
      expect(joinSentOn(first)).toMatchObject({ displayName: 'ridham' });
      first.triggerMessage(WORLD);

      const second = dropAndReconnect(first);

      expect(joinSentOn(second)).toEqual({
        type: 'join',
        memberId: 'm1',
        memberSecret: 's3cret',
      });
    });

    it('does not stand an admitted knocker back in the queue', () => {
      // Being let in through a knock-mode door is still an arrival, and the
      // intent that produced it would produce another knock.
      const first = start(INVITED);
      first.triggerMessage({ type: 'knocking', answerable: true });
      first.triggerMessage(WORLD);

      const second = dropAndReconnect(first);

      expect(joinSentOn(second)).toMatchObject({ memberId: 'm1' });
      expect(useStore.getState().knocking).toBe(false);
    });

    it('surfaces a removal that happened while the tab was disconnected', () => {
      // Kicked, banned or deleted mid-blip, the office cannot tell us which:
      // `authMember` refuses every inactive row the same way. What it can do
      // is stop pretending we are still in there — the credentials are dead,
      // so they are forgotten, the retrying stops, and the form comes back
      // with the office's reason on it.
      const first = start(CREATE);
      first.triggerMessage(WORLD);
      expect(loadIdentity('the-lab-k4xp2q')).not.toBeNull();

      const second = dropAndReconnect(first);
      second.triggerMessage({ type: 'error', code: 'bad-join', message: 'unknown member' });

      expect(loadIdentity('the-lab-k4xp2q')).toBeNull();
      expect(useStore.getState().phase).toBe('join');
      expect(useStore.getState().connection).toBe('idle');
      expect(useStore.getState().joinError).toBe('unknown member');
      // And it stays refused: retrying the same dead credentials every few
      // seconds is how a real refusal turns into a flickering screen.
      const opened = FakeWebSocket.instances.length;
      second.triggerClose();
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(opened);
    });

    it('stops knocking again after being refused at the door', () => {
      // A denied knock arrives as an error and the office hangs up. Without
      // ending the attempt, the backoff would put this browser straight back
      // in the queue, forever, under the name that was just turned away.
      const first = start(INVITED);
      first.triggerMessage({ type: 'knocking', answerable: true });
      first.triggerMessage({
        type: 'error',
        code: 'forbidden',
        message: 'nobody let you in this time',
      });

      const opened = FakeWebSocket.instances.length;
      first.triggerClose();
      vi.advanceTimersByTime(60_000);

      expect(FakeWebSocket.instances).toHaveLength(opened);
      expect(useStore.getState().knocking).toBe(false);
      expect(useStore.getState().joinError).toBe('nobody let you in this time');
    });

    it('reconnects into the office it is in, not the code it arrived on', () => {
      // The intent has to follow the rotation as well as the storage key: it
      // is what a reconnect loads credentials by, and pointing it at the old
      // code after the identity moved is "No identity for this office here"
      // on the next wifi blip.
      const first = start(CREATE);
      first.triggerMessage(WORLD);
      first.triggerMessage(workspaceAt(ROTATED));

      const second = dropAndReconnect(first);

      expect(joinSentOn(second)).toEqual({
        type: 'join',
        memberId: 'm1',
        memberSecret: 's3cret',
      });
      expect(useStore.getState().joinError).toBeNull();
    });

    it('keeps the connection when the office refuses something from inside', () => {
      // A refused admin op is an answer, not a door slamming: ending the
      // attempt on every error would drop somebody out of the office for
      // clicking Ban on a person who outranks them.
      const first = start(CREATE);
      first.triggerMessage(WORLD);

      first.triggerMessage({ type: 'error', code: 'forbidden', message: 'they outrank you' });

      expect(useStore.getState().phase).toBe('world');
      expect(useStore.getState().adminError).toBe('they outrank you');
      const second = dropAndReconnect(first);
      expect(joinSentOn(second)).toMatchObject({ memberId: 'm1' });
    });
  });

  /**
   * Credentials are filed under the office's invite code, because that is the
   * only name a browser has for an office. An owner can change it — and used
   * to change it out from under everybody, leaving each browser's identity in
   * a drawer nothing opened again: the address bar moved to the new code, the
   * next reload found nothing under it, and the office offered a member their
   * own name and refused it as taken. Anyone without a paired collector had
   * no way back to their seat or their history.
   */
  describe('when the office rotates its invite', () => {
    /** The credentials a browser holds for an office it is already in. */
    const IDENTITY = { memberId: 'm1', memberSecret: 's3cret' };

    it('re-files the identity under the new code as the change arrives', () => {
      const ws = start(CREATE);
      ws.triggerMessage(WORLD);
      expect(loadIdentity('the-lab-k4xp2q')).toEqual(IDENTITY);

      ws.triggerMessage(workspaceAt(ROTATED));

      expect(loadIdentity(ROTATED)).toEqual(IDENTITY);
      // Moved, not copied: a second copy under a dead code is a credential
      // going stale somewhere nobody is looking.
      expect(loadIdentity('the-lab-k4xp2q')).toBeNull();
    });

    it('lets the reload that follows step straight back in', () => {
      const ws = start(CREATE);
      ws.triggerMessage(WORLD);
      ws.triggerMessage(workspaceAt(ROTATED));
      socket?.stop();

      // A fresh tab, on the corrected URL — which is where `App` sends it the
      // moment the store hears the new code.
      const reopened = start({ kind: 'resume', roomCode: ROTATED });

      expect(joinSentOn(reopened)).toEqual({ type: 'join', ...IDENTITY });
      expect(useStore.getState().joinError).toBeNull();
    });

    it('re-files an offline member the moment their old link lets them back in', () => {
      // They were away when it rotated, so nobody told them anything. Their
      // credentials are still under the old code and their link still points
      // at it — and that is enough, because the office was never identified
      // by the code: `memberId` and `memberSecret` name it by themselves.
      storageData.set('sloppers:identity:the-lab-k4xp2q', JSON.stringify(IDENTITY));

      const ws = start({ kind: 'resume', roomCode: 'the-lab-k4xp2q' });
      expect(joinSentOn(ws)).toEqual({ type: 'join', ...IDENTITY });

      // Resuming mints nothing, so the world carries no secret — the code it
      // carries is the only news in it, and this is the one moment the
      // browser can act on it before the address bar is corrected under them.
      ws.triggerMessage({ ...WORLD, you: { memberId: 'm1' }, roomCode: ROTATED });

      expect(loadIdentity(ROTATED)).toEqual(IDENTITY);
      expect(loadIdentity('the-lab-k4xp2q')).toBeNull();
    });
  });

  /**
   * A knock is answered twice: once by the moderator who says yes, and once
   * by the office, which only checks the name at that second moment — someone
   * else may have taken it while they stood there. The refusal used to arrive
   * on a socket the office then dropped, behind a "Waiting…" screen that
   * cleared only on a `world` that was never coming.
   */
  it('sends a knocker refused on the way in back to the form, ready to try again', () => {
    vi.useFakeTimers();
    const first = start(INVITED);
    first.triggerMessage({ type: 'knocking', answerable: true });
    expect(useStore.getState().knocking).toBe(true);

    first.triggerMessage({
      type: 'error',
      code: 'name-taken',
      message: 'someone here is already called ridham',
    });

    const state = useStore.getState();
    expect(state.knocking).toBe(false);
    expect(state.phase).toBe('join');
    expect(state.connection).toBe('idle');
    expect(state.joinError).toBe('someone here is already called ridham');

    // And the attempt is over: reconnecting would stand them back in a queue
    // under the one name the office has just told them it cannot give them.
    const opened = FakeWebSocket.instances.length;
    first.triggerClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(opened);

    // Another name is theirs to offer, on a connection of its own.
    const retry = start({ ...INVITED, displayName: 'ridham the second' });

    expect(joinSentOn(retry)).toMatchObject({
      roomCode: 'the-lab-k4xp2q',
      displayName: 'ridham the second',
    });
  });
});
