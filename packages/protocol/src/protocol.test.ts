import { describe, expect, it } from 'vitest';
import {
  addTokens,
  billedTokens,
  collectorSnapshotSchema,
  collectorToServerSchema,
  dailyStatsSchema,
  emptyTokens,
  processedTokens,
  serverToCollectorSchema,
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

  it('accepts a snapshot from a collector too old to state its token sharing', () => {
    // `sloppers@0.1.x` is in the wild and sends exactly this. Absent is not
    // false: the server reads it as "cannot tell", never as "withheld".
    const msg = { type: 'snapshot', sessions: [session], machine: {} };
    expect(collectorSnapshotSchema.parse(msg).sharesTokens).toBeUndefined();
  });

  it('carries a stated refusal to share token numbers', () => {
    const msg = { type: 'snapshot', sessions: [], machine: {}, sharesTokens: false };
    expect(collectorSnapshotSchema.parse(msg).sharesTokens).toBe(false);
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

  it('carries the codes a collector branches on, new ones included', () => {
    // Additive only: 0.1.x is out there and speaks this protocol, so the
    // codes it already knows have to keep parsing exactly as they did, and
    // one it has never heard of has to fail its parse rather than land as
    // something it might mistake for a different code — a rejected message
    // is dropped, and dropping is the safe half of the compatibility deal.
    for (const code of ['unknown-device', 'superseded', 'bad-message', 'server-error']) {
      const parsed = serverToCollectorSchema.safeParse({ type: 'error', code, message: 'why' });
      expect([code, parsed.success]).toEqual([code, true]);
    }
    expect(
      serverToCollectorSchema.safeParse({ type: 'error', code: 'member-removed', message: 'why' })
        .success,
    ).toBe(true);
    expect(
      serverToCollectorSchema.safeParse({ type: 'error', code: 'from-the-future', message: 'why' })
        .success,
    ).toBe(false);
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

  it('processes all four classes, cache included', () => {
    expect(processedTokens({ input: 7, output: 5, cacheRead: 1000, cacheWrite: 9 })).toBe(1021);
    expect(processedTokens(emptyTokens())).toBe(0);
  });

  it('keeps the two apart: the board metric is not the billed one', () => {
    // The whole point of having both. If somebody ever "simplifies" these into
    // one function, this is the line that stops it.
    const day = { input: 7, output: 5, cacheRead: 1000, cacheWrite: 9 };
    expect(processedTokens(day)).not.toBe(billedTokens(day));
  });

  // ------------------------------------------- the harness bias, as measured

  /**
   * Five production days, from `daily_usage`. Claude Code's uncached input over
   * the whole span is 1,474 tokens against 365M cache reads — a 99.9996% hit
   * rate — so `input + output` for that member is output and nothing else.
   */
  const CLAUDE_DAY = { input: 1_474, output: 673_021, cacheRead: 365_482_656, cacheWrite: 0 };
  const CODEX_DAY = {
    input: 230_206_379_856,
    output: 31_305_996_727,
    cacheRead: 14_712_597_139_840,
    cacheWrite: 0,
  };

  it('counted Claude Code as output alone, which is what billedTokens still does', () => {
    // Not a bug in `billedTokens` — a fact about the harness that made it the
    // wrong thing to rank on. Pinned so the premise of the change stays visible.
    expect(billedTokens(CLAUDE_DAY) / CLAUDE_DAY.output).toBeCloseTo(1.0, 2);
    expect(billedTokens(CODEX_DAY) / CODEX_DAY.output).toBeCloseTo(8.35, 1);
  });

  it('closes the gap between the two harnesses once cache reads count', () => {
    // Billed: Codex's ratio to Claude Code's is ~9.7x on the same days. On
    // total tokens processed the two land within a factor of two of each
    // other's share, because the cache reads both harnesses actually did are
    // finally in the sum.
    const billedShare = (t: typeof CLAUDE_DAY) => billedTokens(t) / processedTokens(t);
    expect(billedShare(CODEX_DAY) / billedShare(CLAUDE_DAY)).toBeGreaterThan(8);
    expect(processedTokens(CLAUDE_DAY)).toBeGreaterThan(365_000_000);
  });
});

describe('dailyStatsSchema', () => {
  const base = {
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    sessionsRun: 1,
    activeMinutes: 5,
  };

  it('accepts a day with neither of the new fields, as 0.1.x servers send it', () => {
    const parsed = dailyStatsSchema.parse(base);
    expect(parsed.tokensShared).toBeUndefined();
    expect(parsed.precision).toBeUndefined();
  });

  it('carries the withheld flag and the precision of the counts', () => {
    const parsed = dailyStatsSchema.parse({
      ...base,
      tokensShared: false,
      precision: 'measured',
    });
    expect(parsed.tokensShared).toBe(false);
    expect(parsed.precision).toBe('measured');
  });

  it('refuses a precision it has no meaning for', () => {
    expect(dailyStatsSchema.safeParse({ ...base, precision: 'exact' }).success).toBe(false);
  });
});
