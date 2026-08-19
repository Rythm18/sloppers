import type { SessionSnapshot } from '@sloppers/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db/index.js';
import { TokenLedger } from './ledger.js';

/**
 * Why this file exists, separately from `ledger.test.ts`: the collector may now
 * report two sessions that the harness gave the same id — Codex reassigns
 * `sessionId` on every `session_meta`, and since two non-sidechain rollouts are
 * no longer merged into one session, both reach the wire. `TokenLedger.ingest`
 * keys its watermark on the snapshot id alone, so this pins what that costs and
 * proves the collector's disambiguation is what keeps the leaderboard finite.
 */

/** Local 10:00 today-ish; `TokenLedger.dayOf` reads local time. */
const T0 = new Date('2026-08-17T10:00:00').getTime();

function session(id: string, input: number): SessionSnapshot {
  return {
    id,
    harness: 'codex',
    state: 'working',
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Started today, so the ledger's "history predates today" guard does not
    // fire and the whole cumulative is eligible — the worst case for drift.
    startedAt: T0,
    lastActivityAt: T0,
  };
}

describe('TokenLedger with colliding session ids', () => {
  let db: Db;
  let ledger: TokenLedger;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('w1', 'lab', 'lab-abc', '{}', T0);
    db.prepare(
      `INSERT INTO members
         (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'w1', 's', 'Dev', 'pixel', 'owner', 'active', T0, T0);
    ledger = new TokenLedger(db);
  });

  /** Ten cycles of the same unchanging batch, as a live collector would send. */
  function replay(batch: SessionSnapshot[]): number[] {
    const totals: number[] = [];
    for (let cycle = 0; cycle < 10; cycle++) {
      ledger.ingest('m1', batch, T0 + cycle * 1000);
      totals.push(ledger.todayFor('m1', T0).tokens.input);
    }
    return totals;
  }

  it('inflates without bound when one batch carries an id twice', () => {
    // The hazard, pinned so it cannot be reintroduced silently: the second
    // snapshot's smaller cumulative trips the `shrank` branch and restates the
    // shared watermark downward, so the same difference is re-banked forever.
    const totals = replay([session('s-shared', 100), session('s-shared', 40)]);
    expect(totals[0]).toBe(100);
    expect(totals.at(-1)).toBeGreaterThan(totals[0] ?? 0);
    // Strictly monotonic: nothing damps it, so it never settles.
    for (let i = 1; i < totals.length; i++) {
      expect(totals[i]).toBeGreaterThan(totals[i - 1] ?? 0);
    }
    expect(totals.at(-1)).toBe(640);
  });

  it('settles once the collector disambiguates the colliding id', () => {
    // What `SessionTracker.snapshot` now emits: same session, distinct wire id.
    const totals = replay([session('s-shared', 100), session('s-shared#deadbeefcafe0001', 40)]);
    expect(totals[0]).toBe(140);
    // Banked once on the first cycle, then flat forever.
    expect(new Set(totals)).toEqual(new Set([140]));
  });
});
