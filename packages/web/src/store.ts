import type {
  ChatMessage,
  KnockView,
  LeaderboardRow,
  MemberRole,
  MemberView,
  RosterEntry,
  ServerToWeb,
  WebDeviceLink,
  WebError,
  WebHistoryResult,
  WebRemoved,
  WorkspaceSettings,
} from '@sloppers/protocol';
import { CHAT_KEPT, dayOf } from '@sloppers/protocol';
import { create } from 'zustand';
import { routeServerMessage } from './game/bridge.js';
import { isStackedLayout } from './ui/viewport.js';

export type Phase = 'join' | 'world';
export type Connection = 'idle' | 'connecting' | 'open' | 'reconnecting';
/** Why this browser's member was removed — mirrors the wire message's `reason`. */
export type RemovalReason = WebRemoved['reason'];
type DeviceLink = Pick<WebDeviceLink, 'url' | 'expiresAt'>;

/** Fields reset to these values by both the initial state and `reset()`. */
const initialState = {
  phase: 'join' as Phase,
  connection: 'idle' as Connection,
  roomCode: '',
  roomName: '',
  you: null as string | null,
  members: {} as Record<string, MemberView>,
  leaderboard: [] as LeaderboardRow[],
  nearby: [] as string[],
  focusedId: null as string | null,
  shareOpen: false,
  /**
   * Open where the board sits beside the office and shut where it would
   * arrive as a sheet across half of it. The first thing a friend following
   * an invite on a phone should see is the room, not a scoreboard reading
   * "no tokens burned yet today" over the top of it — and the Board button
   * is right there. Read once, at load: a phone turned sideways mid-session
   * has not asked for the board.
   */
  leaderboardOpen: !isStackedLayout(),
  /**
   * The office's recent days, as the server served them — one request per
   * connection, kept for the life of it.
   *
   * Held whole rather than sliced per view because one answer feeds both
   * readers: the board's day switch takes one day across every member, the
   * member card's strip takes every day of one member. Fetching those
   * separately would be two requests for data that arrives in one, and two
   * chances for them to disagree about the same day.
   */
  history: null as WebHistoryResult | null,
  /** A history request is out and unanswered. Keeps a click from becoming a flood. */
  historyPending: false,
  /**
   * The client-local day the answer landed on. Not a second definition of
   * "today" — never compared against `history.days`, which are the office's
   * days and may well be a different date — only against *itself later*: when
   * this browser's date is no longer the one the answer arrived on, a night
   * has passed and every cached label ("Yesterday") is worth re-asking about.
   * A reconnect already clears the cache; this catches the connection that
   * quietly outlives midnight. Deliberately the browser's own midnight and not
   * the office's: it is a hint about how long this answer has been sitting
   * here, and being an hour early or late about that costs one extra request.
   */
  historyFetchedDay: null as string | null,
  /**
   * Which day the board is showing: 0 today, 1 yesterday — an index into
   * `history.days`, not a date this browser worked out for itself. The days
   * are cut in the *office's* timezone, which this browser is not necessarily
   * in and never needs to know: a client doing its own arithmetic is exactly
   * how a panel ends up with two definitions of today in it. The one clock
   * question the browser answers for itself is `historyFetchedDay`, which is a
   * staleness hint and never a label.
   */
  boardDay: 0,
  /**
   * The office day this browser's member was last here on, when the office
   * judged this arrival a return from a real absence — and null on every other
   * connection, which is most of them.
   *
   * The server's field, kept under the server's name and never computed here:
   * what counts as "away" is policy, the clock it is measured on is the
   * office's, and a browser that worked either of them out for itself would
   * greet somebody for a reload it slept through. Cleared by dismissal and by
   * any `world` that does not carry one, so nothing can outlive the arrival it
   * describes.
   */
  lastHereDay: null as string | null,
  joinError: null as string | null,
  settings: null as WorkspaceSettings | null,
  myRole: null as MemberRole | null,
  knocks: [] as KnockView[],
  roster: [] as RosterEntry[],
  deviceLink: null as DeviceLink | null,
  removed: null as RemovalReason | null,
  knocking: false,
  /**
   * Whether anybody who could let us in is connected, while `knocking`.
   * `null` is "the office did not say" — an older server, and a thing the
   * waiting screen must not pretend to know either way.
   */
  doorAnswerable: null as boolean | null,
  settingsOpen: false,
  /** The conversation, oldest first — the office's `chat-log` and what follows it. */
  chat: [] as ChatMessage[],
  /**
   * Open where the panel sits beside the office, shut where it would arrive as
   * a sheet across the room. The board's own reasoning, word for word (see
   * `leaderboardOpen`), and for a stronger reason: this panel carries a text
   * field, so on a phone it brings a keyboard with it. The first thing an
   * invited friend should meet is the room, not a keyboard over it — and the
   * Chat button is right there, wearing the dot when somebody has spoken.
   */
  chatOpen: !isStackedLayout(),
  /**
   * How many lines have arrived that this browser has not put on screen. Only
   * ever counts up while the panel is shut, and only for other people's
   * messages — your own coming back is the office confirming it landed.
   *
   * Rendered as a dot rather than a number, so it does not matter that a
   * message deleted while unread leaves this one too high. The count is kept
   * anyway because the button has to *say* something to a screen reader, and
   * "chat, 3 new" is that sentence.
   */
  chatUnread: 0,
  /**
   * The moment the first unseen line landed, so the panel can draw a rule
   * where somebody stopped reading. The office's number — see the wire's
   * `unreadSince` — and null on every arrival that missed nothing, which is
   * most of them.
   *
   * Cleared by saying something rather than by opening the panel: on a laptop
   * the panel is already open when this arrives, so clearing it on open would
   * mean nobody with a wide screen ever saw the mark. Answering is the moment
   * somebody is demonstrably caught up.
   */
  chatUnreadSince: null as number | null,
  /**
   * The office refusing something somebody typed — a flood, or a line with
   * nothing in it once the office had flattened it.
   *
   * Its own field rather than `adminError`, and the reason is the shape of the
   * two: an admin refusal answers a click on a control that is on screen, and
   * a chat refusal answers a sentence in a text box. Routed apart on the wire
   * too (`chat-refused`), because a browser cannot tell which it is holding.
   */
  chatError: null as string | null,
  /**
   * The office's answer to something somebody just did in here — "they
   * outrank you", "that knock is gone", "only the owner renames the office".
   *
   * Every admin op can be refused, and the refusal arrives as an ordinary
   * error message carrying no clue which op it is about. Left unread, a
   * moderator clicks Ban, is told no, and watches nothing happen; the panel
   * pairs this with the control it last used to put the answer back where
   * the click was.
   */
  adminError: null as string | null,
};

type State = typeof initialState;

interface SloppersStore extends State {
  setRoomCode(code: string): void;
  setConnection(connection: Connection): void;
  setNearby(ids: string[]): void;
  setFocused(id: string | null): void;
  setShareOpen(open: boolean): void;
  setLeaderboardOpen(open: boolean): void;
  setBoardDay(offset: number): void;
  setHistoryPending(pending: boolean): void;
  /** Drop a history answer fetched on an earlier local day; see `historyFetchedDay`. */
  expireStaleHistory(): void;
  /** Put the "while you were away" panel away; see `lastHereDay`. */
  dismissGreeting(): void;
  setJoinError(error: string | null): void;
  setSettingsOpen(open: boolean): void;
  /** Show or hide the conversation. Opening it is what marks it read. */
  setChatOpen(open: boolean): void;
  /** Somebody answered: drop the "new since you left" rule and any refusal. */
  chatCaughtUp(): void;
  setChatError(message: string | null): void;
  setAdminError(message: string | null): void;
  setDeviceLink(link: DeviceLink | null): void;
  applyServer(msg: ServerToWeb): void;
  reset(): void;
}

/**
 * Refusals at the door whose full truth the office's own wording does not
 * carry. Normally the server's sentence is the most specific thing anyone can
 * say and it goes straight to the form; a locked office is the exception. It
 * says only that it is not taking new people, which leaves the obvious next
 * move — knock and wait — sounding available when it is the one thing a
 * locked door does not offer.
 */
const DOOR_REFUSALS: Partial<Record<WebError['code'], string>> = {
  'workspace-locked':
    'This office is closed to new people right now — knocking is not an option here. Ask somebody inside to open it up for you.',
};

/** `myRole` isn't its own message — it's read off the member view matching `you`. */
function deriveMyRole(you: string | null, members: Record<string, MemberView>): MemberRole | null {
  return you ? (members[you]?.role ?? null) : null;
}

export const useStore = create<SloppersStore>((set) => ({
  ...initialState,

  setRoomCode: (roomCode) => set({ roomCode }),
  setConnection: (connection) => set({ connection }),
  setNearby: (nearby) => set({ nearby }),
  setFocused: (focusedId) => set({ focusedId }),
  setShareOpen: (shareOpen) => set({ shareOpen }),
  setLeaderboardOpen: (leaderboardOpen) => set({ leaderboardOpen }),
  setBoardDay: (boardDay) => set({ boardDay }),
  setHistoryPending: (historyPending) => set({ historyPending }),
  expireStaleHistory: () =>
    set((s) =>
      s.history && s.historyFetchedDay !== dayOf(Date.now())
        ? { history: null, historyFetchedDay: null }
        : s,
    ),
  dismissGreeting: () => set({ lastHereDay: null }),
  setJoinError: (joinError) => set({ joinError }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setChatOpen: (chatOpen) => set(chatOpen ? { chatOpen, chatUnread: 0 } : { chatOpen }),
  chatCaughtUp: () => set({ chatUnreadSince: null, chatError: null }),
  setChatError: (chatError) => set({ chatError }),
  setAdminError: (adminError) => set({ adminError }),
  setDeviceLink: (deviceLink) => set({ deviceLink }),

  applyServer: (msg) => {
    // Phaser hears about world/membership/position through the bridge.
    routeServerMessage(msg);
    switch (msg.type) {
      case 'world': {
        const members = Object.fromEntries(msg.members.map((m) => [m.id, m]));
        set({
          phase: 'world',
          connection: 'open',
          roomCode: msg.roomCode,
          roomName: msg.roomName,
          you: msg.you.memberId,
          members,
          leaderboard: msg.leaderboard,
          joinError: null,
          // A refusal describes a session that has just ended; carrying it
          // into the next one would explain a click nobody made.
          adminError: null,
          myRole: deriveMyRole(msg.you.memberId, members),
          // A successful join means any door-waiting is over, and any prior
          // removal no longer describes the current session.
          knocking: false,
          doorAnswerable: null,
          removed: null,
          // Dropped rather than carried across. A world message is a fresh
          // connection, and the office may well have been left open past
          // midnight — in which case every day key in the old answer is off by
          // one and "yesterday" would be labelling the day before it.
          history: null,
          historyPending: false,
          historyFetchedDay: null,
          boardDay: 0,
          // Set from the arrival rather than carried across it. A reconnect a
          // few seconds after this one gets a `world` with no `lastHereDay` on
          // it — the office stamped this browser present the moment it walked
          // in — and that absence of a field has to *clear* the greeting, or a
          // dropped socket would re-open a panel somebody already read.
          lastHereDay: msg.lastHereDay ?? null,
          // Emptied, not carried across: a `chat-log` is on its way behind
          // this message and is the office's own account of what was said.
          // Keeping the old lines until it lands would show a conversation
          // that may have been trimmed, deleted from, or aged out while this
          // browser was away. `chatOpen` is deliberately not reset — a
          // reconnect must not close a panel somebody is reading.
          chat: [],
          chatUnread: 0,
          chatUnreadSince: null,
          chatError: null,
        });
        break;
      }
      case 'member':
        set((s) => {
          const members = { ...s.members, [msg.member.id]: msg.member };
          return {
            members,
            myRole: msg.member.id === s.you ? msg.member.role : s.myRole,
          };
        });
        break;
      case 'member-left':
        set((s) => {
          const { [msg.memberId]: gone, ...rest } = s.members;
          void gone;
          // Out of the history too. The office's own answer already leaves
          // departed members out, but this browser is holding one from before
          // they left — and a board that ranks somebody the room can no longer
          // show is a row nobody can click.
          const history = s.history
            ? {
                ...s.history,
                members: s.history.members.filter((m) => m.memberId !== msg.memberId),
              }
            : null;
          return { members: rest, history };
        });
        break;
      case 'presence':
        set((s) => {
          const existing = s.members[msg.memberId];
          if (!existing) return s;
          return {
            members: {
              ...s.members,
              [msg.memberId]: {
                ...existing,
                presence: msg.presence,
                sessions: msg.sessions,
                today: msg.today,
              },
            },
          };
        });
        break;
      case 'leaderboard':
        set({ leaderboard: msg.rows });
        break;
      case 'history':
        set({ history: msg, historyPending: false, historyFetchedDay: dayOf(Date.now()) });
        break;
      case 'chat-log':
        // The office's account of the conversation, replacing whatever was
        // held. Whether any of it is unread is the office's judgement too —
        // it knows when a browser of this member's was last actually here, and
        // this browser does not.
        set((s) => ({
          chat: msg.messages,
          chatUnreadSince: msg.unreadSince ?? null,
          // A panel that is already open is a panel being read, so there is
          // nothing to announce on the button behind it.
          chatUnread:
            s.chatOpen || msg.unreadSince === undefined
              ? 0
              : msg.messages.filter((m) => m.at >= (msg.unreadSince ?? 0) && m.memberId !== s.you)
                  .length,
        }));
        break;
      case 'chat':
        set((s) => {
          // Capped at what the office itself keeps, so a tab left open for a
          // week holds exactly the scrollback the office would hand back on
          // the next visit — and cannot grow without bound either way.
          const chat = [...s.chat, msg.message].slice(-CHAT_KEPT);
          const mine = msg.message.memberId === s.you;
          return {
            chat,
            chatUnread: s.chatOpen || mine ? s.chatUnread : s.chatUnread + 1,
          };
        });
        break;
      case 'chat-removed':
        set((s) => ({ chat: s.chat.filter((m) => m.id !== msg.id) }));
        break;
      case 'knocking':
        // Waiting on an owner/moderator decision at a knock-mode door. Sent
        // again, unprompted, whenever the office gains or loses everyone who
        // could answer — so this is a refresh as often as it is an arrival.
        set({ knocking: true, doorAnswerable: msg.answerable ?? null });
        break;
      case 'knocks':
        set({ knocks: msg.knocks });
        break;
      case 'workspace':
        // roomCode/roomName are frozen wire names; the office's invite code
        // or display name may have just changed (rename, rotate-invite).
        set((s) => ({
          roomCode: msg.roomCode,
          roomName: msg.roomName,
          // A settings change can move the office's midnight, and a cached
          // history keeps the old anchor — leaving "Yesterday" able to label
          // the office's current today until a reconnect. Dropping the cache
          // costs one re-request (the board's effect re-asks) and keeps one
          // definition of today in the panel.
          history: s.settings?.timezone === msg.settings.timezone ? s.history : null,
          historyFetchedDay:
            s.settings?.timezone === msg.settings.timezone ? s.historyFetchedDay : null,
          settings: msg.settings,
        }));
        break;
      case 'roster':
        set({ roster: msg.members });
        break;
      case 'removed':
        // Terminal for this session: the member is gone (kicked, banned, or
        // deleted). Land on the join screen, actionable — not stuck on
        // 'connecting'/'reconnecting' with no way out.
        set({ removed: msg.reason, phase: 'join', connection: 'idle' });
        break;
      case 'device-link':
        set({ deviceLink: { url: msg.url, expiresAt: msg.expiresAt } });
        break;
      case 'error':
        set((s) => {
          // The one refusal on this wire that says where it belongs. Ahead of
          // everything below because it is the exception to all of it: it is
          // neither a door refusing a join nor the office refusing a click,
          // and it deliberately does *not* release `historyPending` — the
          // blanket release below exists because the wire cannot say which
          // answerable message an error is about, and this one can.
          if (msg.code === 'chat-refused') return { chatError: msg.message };
          // Inside the office, on an open connection, this browser sends
          // moves, presence, admin ops and history requests — and the first two
          // are never answered. So an error arriving here is the office
          // refusing something somebody just clicked, and it belongs on that
          // screen rather than nowhere. Held as the message alone: the wire
          // says why, not what it is about, and the panel is what knows which
          // control asked. `connection` is load-bearing: a reconnect that is
          // refused arrives while `phase` still says 'world', and reading it
          // as a refused click would leave somebody staring at an office they
          // are no longer in.
          //
          // The wire cannot say which of the two answerable messages this is
          // about, so an outstanding history request is released either way.
          // Releasing one that was in fact fine costs nothing — the answer
          // still arrives and still lands — while holding one that was refused
          // leaves "Yesterday" reading "loading…" until the tab is reloaded.
          if (s.phase === 'world' && s.connection === 'open') {
            return { adminError: msg.message, historyPending: false };
          }
          // Otherwise the door is answering: a join it will not take, a knock
          // somebody said no to, or a resume it no longer honours. Every code
          // that can arrive here ends the attempt, so rather than listing the
          // ones we happen to have met — which is how the button came to sit
          // on 'Stepping in…' forever for the ones we had not — all of them
          // put the form back, enabled, with the reason on it.
          return {
            joinError: DOOR_REFUSALS[msg.code] ?? msg.message,
            phase: 'join' as Phase,
            connection: 'idle' as Connection,
            // The wait is over either way, and a refusal shown behind the
            // waiting screen is a refusal nobody reads.
            knocking: false,
          };
        });
        break;
      default:
        break;
    }
  },

  reset: () => set({ ...initialState }),
}));
