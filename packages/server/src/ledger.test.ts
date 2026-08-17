import type { SessionSnapshot, TokenTotals } from '@sloppers/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { TokenLedger } from './ledger.js';

const T0 = new Date('2026-08-17T10:00:00').getTime();

function session(id: string, tokens: Partial<TokenTotals>, state = 'working'): SessionSnapshot {
  return {
    id,
    harness: 'claude-code',
    state: state as SessionSnapshot['state'],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
    startedAt: T0,
    lastActivityAt: T0,
  };
}

describe('TokenLedger', () => {
  let db: Db;
  let ledger: TokenLedger;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare('INSERT INTO rooms (code, created_at) VALUES (?, ?)').run('r', T0);
    db.prepare(
      'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m1', 'r', 's', 'Dev', 'pixel', T0);
    ledger = new TokenLedger(db);
  });

  it('counts a new session fully, then only deltas', () => {
    ledger.ingest('m1', [session('s1', { input: 100, output: 10 })], T0);
    expect(ledger.todayFor('m1', T0).tokens).toMatchObject({ input: 100, output: 10 });

    ledger.ingest('m1', [session('s1', { input: 150, output: 25 })], T0 + 1000);
    expect(ledger.todayFor('m1', T0).tokens).toMatchObject({ input: 150, output: 25 });
  });

  it('re-sent identical snapshots add nothing (idempotent)', () => {
    const snap = [session('s1', { input: 100, output: 10, cacheRead: 500 })];
    ledger.ingest('m1', snap, T0);
    ledger.ingest('m1', snap, T0 + 1000);
    ledger.ingest('m1', snap, T0 + 2000);
    expect(ledger.todayFor('m1', T0).tokens).toMatchObject({
      input: 100,
      output: 10,
      cacheRead: 500,
    });
  });

  it('absorbs a shrinking cumulative without going negative', () => {
    ledger.ingest('m1', [session('s1', { input: 1000 })], T0);
    ledger.ingest('m1', [session('s1', { input: 400 })], T0 + 1000);
    expect(ledger.todayFor('m1', T0).tokens.input).toBe(1000);
    // Growth beyond the new lower watermark counts again.
    ledger.ingest('m1', [session('s1', { input: 500 })], T0 + 2000);
    expect(ledger.todayFor('m1', T0).tokens.input).toBe(1100);
  });

  it('splits token growth across day boundaries', () => {
    const day2 = new Date('2026-08-18T00:10:00').getTime();
    ledger.ingest('m1', [session('s1', { input: 100 })], T0);
    ledger.ingest('m1', [session('s1', { input: 300 })], day2);
    expect(ledger.todayFor('m1', T0).tokens.input).toBe(100);
    expect(ledger.todayFor('m1', day2).tokens.input).toBe(200);
  });

  it('counts sessions once, on first sight', () => {
    ledger.ingest('m1', [session('s1', { input: 1 })], T0);
    ledger.ingest('m1', [session('s1', { input: 2 }), session('s2', { input: 1 })], T0 + 1000);
    ledger.ingest('m1', [session('s2', { input: 5 })], T0 + 2000);
    expect(ledger.todayFor('m1', T0).sessionsRun).toBe(2);
  });

  it('accrues one active minute per minute with a working session', () => {
    ledger.ingest('m1', [session('s1', { input: 1 })], T0);
    ledger.ingest('m1', [session('s1', { input: 2 })], T0 + 10_000); // same minute
    ledger.ingest('m1', [session('s1', { input: 3 })], T0 + 61_000); // next minute
    ledger.ingest('m1', [session('s1', { input: 4 }, 'waiting')], T0 + 121_000); // not working
    expect(ledger.todayFor('m1', T0).activeMinutes).toBe(2);
  });

  it('reports change only when something actually changed', () => {
    const snap = [session('s1', { input: 100 })];
    expect(ledger.ingest('m1', snap, T0)).toBe(true);
    // Same tokens, same minute, still working → active minute already counted.
    expect(ledger.ingest('m1', snap, T0 + 1000)).toBe(false);
  });

  it('keeps members separate', () => {
    db.prepare(
      'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m2', 'r', 's', 'Other', 'mochi', T0);
    ledger.ingest('m1', [session('shared-id', { input: 100 })], T0);
    ledger.ingest('m2', [session('shared-id', { input: 100 })], T0);
    expect(ledger.todayFor('m1', T0).tokens.input).toBe(100);
    expect(ledger.todayFor('m2', T0).tokens.input).toBe(100);
  });

  it('ignores sessions without token data', () => {
    const bare: SessionSnapshot = {
      id: 'no-tokens',
      harness: 'codex',
      state: 'waiting',
      startedAt: T0,
      lastActivityAt: T0,
    };
    expect(ledger.ingest('m1', [bare], T0)).toBe(false);
    expect(ledger.todayFor('m1', T0).sessionsRun).toBe(0);
  });
});
