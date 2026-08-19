import type {
  KnockView,
  LeaderboardRow,
  MemberRole,
  MemberView,
  RosterEntry,
  ServerToWeb,
  WebDeviceLink,
  WebRemoved,
  WorkspaceSettings,
} from '@sloppers/protocol';
import { create } from 'zustand';
import { routeServerMessage } from './game/bridge.js';

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
  leaderboardOpen: true,
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
  setJoinError(error: string | null): void;
  setSettingsOpen(open: boolean): void;
  setAdminError(message: string | null): void;
  setDeviceLink(link: DeviceLink | null): void;
  applyServer(msg: ServerToWeb): void;
  reset(): void;
}

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
  setJoinError: (joinError) => set({ joinError }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
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
          return { members: rest };
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
        set({ roomCode: msg.roomCode, roomName: msg.roomName, settings: msg.settings });
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
          // Inside the office, the only things this browser sends are moves,
          // presence, and admin ops — and the first two are never answered.
          // So an error arriving here is the office refusing something
          // somebody just clicked, and it belongs on that screen rather than
          // nowhere. Held as the message alone: the wire says why, not what
          // it is about, and the panel is what knows which control asked.
          if (s.phase === 'world') return { adminError: msg.message };
          // Fatal join errors land back on the form, re-enabled — leaving
          // connection at 'connecting' would brick the submit button.
          if (
            msg.code === 'name-taken' ||
            msg.code === 'bad-join' ||
            msg.code === 'room-not-found'
          ) {
            return {
              joinError: msg.message,
              phase: 'join' as Phase,
              connection: 'idle' as Connection,
            };
          }
          // A server-side failure before we're in only matters on the door.
          if (msg.code === 'server-error' && s.phase === 'join') {
            return { joinError: msg.message, connection: 'idle' as Connection };
          }
          return s;
        });
        break;
      default:
        break;
    }
  },

  reset: () => set({ ...initialState }),
}));
