import type { LeaderboardRow, MemberView, ServerToWeb } from '@sloppers/protocol';
import { create } from 'zustand';
import { routeServerMessage } from './game/bridge.js';

export type Phase = 'join' | 'world';
export type Connection = 'idle' | 'connecting' | 'open' | 'reconnecting';

interface SloppersStore {
  phase: Phase;
  connection: Connection;
  roomCode: string;
  you: string | null;
  /** Members by id — positions live in Phaser, not here. */
  members: Record<string, MemberView>;
  leaderboard: LeaderboardRow[];
  /** Member ids close enough for an ambient bubble (ordered by distance). */
  nearby: string[];
  /** Member the user clicked; shows the detail card. */
  focusedId: string | null;
  shareOpen: boolean;
  leaderboardOpen: boolean;
  joinError: string | null;

  setRoomCode(code: string): void;
  setConnection(connection: Connection): void;
  setNearby(ids: string[]): void;
  setFocused(id: string | null): void;
  setShareOpen(open: boolean): void;
  setLeaderboardOpen(open: boolean): void;
  setJoinError(error: string | null): void;
  applyServer(msg: ServerToWeb): void;
  reset(): void;
}

export const useStore = create<SloppersStore>((set) => ({
  phase: 'join',
  connection: 'idle',
  roomCode: '',
  you: null,
  members: {},
  leaderboard: [],
  nearby: [],
  focusedId: null,
  shareOpen: false,
  leaderboardOpen: true,
  joinError: null,

  setRoomCode: (roomCode) => set({ roomCode }),
  setConnection: (connection) => set({ connection }),
  setNearby: (nearby) => set({ nearby }),
  setFocused: (focusedId) => set({ focusedId }),
  setShareOpen: (shareOpen) => set({ shareOpen }),
  setLeaderboardOpen: (leaderboardOpen) => set({ leaderboardOpen }),
  setJoinError: (joinError) => set({ joinError }),

  applyServer: (msg) => {
    // Phaser hears about world/membership/position through the bridge.
    routeServerMessage(msg);
    switch (msg.type) {
      case 'world':
        set({
          phase: 'world',
          connection: 'open',
          you: msg.you.memberId,
          members: Object.fromEntries(msg.members.map((m) => [m.id, m])),
          leaderboard: msg.leaderboard,
          joinError: null,
        });
        break;
      case 'member':
        set((s) => ({ members: { ...s.members, [msg.member.id]: msg.member } }));
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
      case 'error':
        set((s) => {
          if (msg.code === 'name-taken' || msg.code === 'bad-join') {
            return { joinError: msg.message, phase: 'join' as Phase };
          }
          // A server-side failure before we're in only matters on the door.
          if (msg.code === 'server-error' && s.phase === 'join') {
            return { joinError: msg.message };
          }
          return s;
        });
        break;
      default:
        break;
    }
  },

  reset: () =>
    set({
      phase: 'join',
      connection: 'idle',
      you: null,
      members: {},
      leaderboard: [],
      nearby: [],
      focusedId: null,
      shareOpen: false,
    }),
}));
