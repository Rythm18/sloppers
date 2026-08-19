import { describe, expect, it } from 'vitest';
import {
  addTokens,
  billedTokens,
  collectorSnapshotSchema,
  collectorToServerSchema,
  emptyTokens,
  serverToWebSchema,
  sessionSnapshotSchema,
  webToServerSchema,
} from './index.js';

const session = {
  id: 'abc-123',
  harness: 'claude-code',
  state: 'working',
  project: 'sloppers',
  branch: 'main',
  model: 'claude-fable-5',
  tokens: { input: 1200, output: 340, cacheRead: 57000, cacheWrite: 900 },
  startedAt: 1755400000000,
  lastActivityAt: 1755400500000,
};

describe('session snapshots', () => {
  it('accepts a fully-populated snapshot', () => {
    expect(sessionSnapshotSchema.parse(session)).toEqual(session);
  });

  it('accepts a maximally-private snapshot (visibility-stripped)', () => {
    const bare = {
      id: 's1',
      harness: 'codex',
      state: 'idle',
      startedAt: 1,
      lastActivityAt: 2,
    };
    expect(sessionSnapshotSchema.parse(bare)).toEqual(bare);
  });

  it('rejects negative token counts', () => {
    const bad = { ...session, tokens: { ...session.tokens, output: -1 } };
    expect(sessionSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects harness ids that are not kebab-case', () => {
    const bad = { ...session, harness: 'Claude Code!' };
    expect(sessionSnapshotSchema.safeParse(bad).success).toBe(false);
  });
});

describe('collector messages', () => {
  it('round-trips a snapshot message', () => {
    const msg = {
      type: 'snapshot',
      sessions: [session],
      machine: { idleSeconds: 42 },
    };
    expect(collectorSnapshotSchema.parse(msg)).toEqual(msg);
  });

  it('routes by discriminator', () => {
    const hello = {
      type: 'hello',
      deviceKey: 'k'.repeat(32),
      collectorVersion: '0.1.0',
    };
    const parsed = collectorToServerSchema.parse(hello);
    expect(parsed.type).toBe('hello');
  });

  it('rejects unknown message types', () => {
    expect(collectorToServerSchema.safeParse({ type: 'exfiltrate' }).success).toBe(false);
  });
});

describe('web messages', () => {
  it('parses invited, create-office, and resume joins', () => {
    const invited = {
      type: 'join',
      roomCode: 'the-lab-k4xp2q',
      displayName: 'Ridham',
      avatar: 'clementine',
    };
    expect(webToServerSchema.parse(invited)).toEqual(invited);
    const create = { type: 'join', createRoom: 'the lab', displayName: 'Ridham' };
    expect(webToServerSchema.parse(create)).toEqual(create);
    const resume = { type: 'join', memberId: 'm1', memberSecret: 's1' };
    expect(webToServerSchema.parse(resume)).toEqual(resume);
  });

  it('trims display names and rejects empty ones', () => {
    const join = { type: 'join', roomCode: 'the-lab', displayName: '   ' };
    expect(webToServerSchema.safeParse(join).success).toBe(false);
  });

  it('parses a world message', () => {
    const world = {
      type: 'world',
      you: { memberId: 'm1', memberSecret: 's1' },
      roomCode: 'the-lab-k4xp2q',
      roomName: 'the lab',
      members: [
        {
          id: 'm1',
          displayName: 'Ridham',
          avatar: 'clementine',
          role: 'owner',
          presence: 'grinding',
          position: { x: 100, y: 200, dir: 'down', moving: false },
          sessions: [session],
          today: {
            tokens: { input: 5000, output: 800, cacheRead: 90000, cacheWrite: 0 },
            sessionsRun: 3,
            activeMinutes: 61,
          },
          sharing: true,
        },
      ],
      leaderboard: [],
    };
    expect(serverToWebSchema.parse(world)).toEqual(world);
  });
});

describe('token helpers', () => {
  it('adds totals fieldwise', () => {
    const sum = addTokens(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    );
    expect(sum).toEqual({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  });

  it('bills input + output only', () => {
    expect(billedTokens({ input: 7, output: 5, cacheRead: 1000, cacheWrite: 9 })).toBe(12);
    expect(billedTokens(emptyTokens())).toBe(0);
  });
});
