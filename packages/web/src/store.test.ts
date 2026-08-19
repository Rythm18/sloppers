import { beforeEach, describe, expect, it } from 'vitest';
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
  });
});
