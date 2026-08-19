import type { SessionSnapshot, TokenTotals, UsageBucket } from '@sloppers/protocol';
import { encodeMinutes, PRICING } from '@sloppers/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from './db/index.js';
import { TokenLedger } from './ledger.js';

/**
 * Local noon on two consecutive days. Local, not UTC: days are cut with
 * `dayOf`, which reads the local calendar, so a UTC instant would file work
 * under the wrong date for anyone not on UTC.
 */
const DAY_18 = new Date(2026, 7, 18, 12, 0).getTime();
const TODAY_19 = new Date(2026, 7, 19, 12, 0).getTime();
const D18 = '2026-08-18';
const D19 = '2026-08-19';
const D20 = '2026-08-20';

/**
 * `startedAt: 1` puts every session's start well before "today", which is the
 * interesting side of the seeding guard; tests that need a session that
 * plainly started today pass their own `startedAt`.
 */
const baseSession = {
  harness: 'claude-code',
  state: 'working',
  startedAt: 1,
  lastActivityAt: 2,
} as const;

function bucket(
  day: string,
  model: string,
  input: number,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
): UsageBucket {
  return { day, model, input, output, cacheRead, cacheWrite };
}

function tokens(input: number, output = 0, cacheRead = 0, cacheWrite = 0): TokenTotals {
  return { input, output, cacheRead, cacheWrite };
}

/** A session reporting day/model buckets — what a 0.2 collector sends. */
function bucketed(id: string, usage: UsageBucket[], startedAt?: number): SessionSnapshot {
  return { ...baseSession, id, usage, ...(startedAt === undefined ? {} : { startedAt }) };
}

/** A session reporting only a cumulative total — what 0.1.1 sends. */
function legacy(id: string, totals: TokenTotals, startedAt?: number): SessionSnapshot {
  return { ...baseSession, id, tokens: totals, ...(startedAt === undefined ? {} : { startedAt }) };
}

/** A session reporting which minutes of a day had activity. */
function withMinutes(id: string, day: string, minutes: number[]): SessionSnapshot {
  return { ...baseSession, id, activeMinutes: [{ day, minutes: encodeMinutes(minutes) }] };
}

/**
 * A model with a price, injected for the cost tests. `PRICING.models` is
 * deliberately empty until a later task fills it from official documentation,
 * and an all-unpriced table cannot tell "null because partial" apart from
 * "null because we know nothing", which is exactly the distinction the
 * `estimatedCostUsd` contract turns on.
 */
const PRICED = 'test-priced-model';

describe('TokenLedger', () => {
  let db: Db;
  let ledger: TokenLedger;

  beforeEach(() => {
    db = openDb(':memory:');
    db.prepare(
      'INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('w1', 'lab', 'lab-abc', '{}', DAY_18);
    db.prepare(
      `INSERT INTO members
         (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'w1', 's', 'Dev', 'pixel', 'owner', 'active', DAY_18, DAY_18);
    PRICING.models[PRICED] = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    ledger = new TokenLedger(db);
  });

  afterEach(() => {
    delete PRICING.models[PRICED];
    db.close();
  });

  // ---------------------------------------------------------------- buckets

  it('credits usage to the day the work happened, not the day we saw it', () => {
    // Seen first on the 18th, so the session is already known and the seeding
    // guard below is out of the picture: both buckets are banked on their own
    // day, including the backfill onto a day that has already ended.
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'claude-opus-5', 60)])], DAY_18);
    ledger.ingest(
      'm1',
      [
        bucketed('s1', [
          bucket(D18, 'claude-opus-5', 100, 10),
          bucket(D19, 'claude-opus-5', 40, 4),
        ]),
      ],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(100);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(40);
  });

  it('splits a day by model', () => {
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 100), bucket(D19, 'claude-haiku-4-5', 900)])],
      TODAY_19,
    );
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.byModel?.['claude-opus-5']?.input).toBe(100);
    expect(today.byModel?.['claude-haiku-4-5']?.input).toBe(900);
    expect(today.tokens.input).toBe(1000);
  });

  it('stays idempotent across re-sends and restarts', () => {
    const snap = [bucketed('s1', [bucket(D19, 'm', 50, 5)])];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m1', snap, TODAY_19 + 5000);
    ledger.ingest('m1', snap, TODAY_19 + 9000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(50);
  });

  it('absorbs a shrinking bucket without going negative', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'm', 1000)])], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'm', 400)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
    // Growth beyond the restated, lower watermark counts again.
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'm', 500)])], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1100);
  });

  it('keeps a watermark per day for a session that runs across midnight', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 100)])], DAY_18);
    // Still running after midnight: yesterday's bucket is restated unchanged
    // and a fresh one opens for today.
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 100), bucket(D19, 'm', 30)])], TODAY_19);
    // Late work attributed back to yesterday still lands on yesterday.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D18, 'm', 120), bucket(D19, 'm', 80)])],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(120);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(80);
  });

  // ------------------------------------------------- the resume seeding rule

  it('absorbs a resume the collector could no longer deduplicate', () => {
    // The invariant is split across two components: the collector drops a
    // resumed request whose original claim is under 24h old, and the server
    // absorbs everything older. This is the server's half, and nothing else
    // stands between an old resume and a doubled day.
    const startedAt = DAY_18 - 60_000;
    ledger.ingest('m1', [bucketed('s-orig', [bucket(D18, 'm', 100)], startedAt)], DAY_18);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(100);

    // `--resume` copies the transcript: a NEW session id, the ORIGINAL usage
    // entries on their original day, and the original's first timestamp as
    // `startedAt`. Under bucket watermarks alone this seeds at zero and banks
    // the replay a second time — on the right day, but still twice.
    ledger.ingest('m1', [bucketed('s-resume', [bucket(D18, 'm', 100)], startedAt)], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(100);

    // Post-resume work is not suppressed along with the replay.
    ledger.ingest(
      'm1',
      [bucketed('s-resume', [bucket(D18, 'm', 100), bucket(D19, 'm', 25)], startedAt)],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(25);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(100);
  });

  it('seeds a legacy collector’s old session instead of dumping its history into today', () => {
    // 0.1.1 sends no buckets at all, so the same guard has to fire off
    // `startedAt` alone. This is the shape the published collector still has.
    const ancient = legacy('ancient', tokens(5_000_000, 900_000), new Date(2026, 6, 1).getTime());
    ledger.ingest('m1', [ancient], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(0);
    // ...but growth from here on counts.
    ledger.ingest(
      'm1',
      [legacy('ancient', tokens(5_000_400, 900_000), new Date(2026, 6, 1).getTime())],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(400);
  });

  it('does not seed a session that plainly started today, whatever day its buckets carry', () => {
    // Days are cut on the *collector's* clock. A collector west of the server
    // labels live work with what is still yesterday here, and that work is
    // not a resume — the session started minutes ago.
    ledger.ingest('m1', [bucketed('fresh', [bucket(D18, 'm', 75)], TODAY_19 - 60_000)], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(75);
  });

  it('banks a bucket dated ahead of the server rather than seeding it', () => {
    // The mirror case: a collector east of the server legitimately reports
    // tomorrow. Nothing about that looks like a replay.
    ledger.ingest('m1', [bucketed('s1', [bucket(D20, 'm', 90)])], TODAY_19);
    expect(ledger.todayFor('m1', new Date(2026, 7, 20, 12, 0).getTime()).tokens.input).toBe(90);
  });

  it('does not re-seed an ordinary restart', () => {
    // A restart re-reports the same session id, so the watermark row is there
    // and the guard never looks at the day at all.
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'm', 100)])], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'm', 100), bucket(D18, 'm', 40)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(100);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(40);
  });

  // ------------------------------------------------------- legacy collectors

  it('still accepts a legacy collector sending only cumulative tokens', () => {
    ledger.ingest('m1', [legacy('s-legacy', tokens(70, 7), TODAY_19 - 60_000)], TODAY_19);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(70);
    expect(today.byModel?.unknown?.input).toBe(70);
  });

  it('carries a flat cumulative across midnight without re-banking it', () => {
    // The flat total is cumulative for the whole *session*, not per day, so
    // its watermark has to be read forward across the day boundary.
    const startedAt = DAY_18 - 60_000;
    ledger.ingest('m1', [legacy('s1', tokens(100), startedAt)], DAY_18);
    ledger.ingest('m1', [legacy('s1', tokens(300), startedAt)], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(100);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(200);
  });

  it('seeds a session the old ledger already counted instead of counting it twice', () => {
    db.prepare('INSERT INTO legacy_sessions (session_id, member_id) VALUES (?, ?)').run(
      's-old',
      'm1',
    );
    ledger.ingest('m1', [bucketed('s-old', [bucket(D19, 'm', 1000, 100)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(0);

    ledger.ingest('m1', [bucketed('s-old', [bucket(D19, 'm', 1400, 100)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(400);
    // The seeding is a one-off: the row is consumed, not consulted forever.
    expect(db.prepare('SELECT COUNT(*) AS n FROM legacy_sessions').get() as { n: number }).toEqual({
      n: 0,
    });
  });

  // ------------------------------------------------------------ minute maps

  it('counts a minute once even when two sessions share it', () => {
    ledger.ingest(
      'm1',
      [withMinutes('s1', D19, [61, 62]), withMinutes('s2', D19, [62, 63])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(3);
  });

  it('never double-counts a re-sent activity bitmap', () => {
    const snap = [withMinutes('s1', D19, [10, 11, 12])];
    ledger.ingest('m1', snap, TODAY_19);
    expect(ledger.ingest('m1', snap, TODAY_19 + 1000)).toBe(false);
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(3);
  });

  it('unions bitmaps reported across separate ingests', () => {
    ledger.ingest('m1', [withMinutes('s1', D19, [61])], TODAY_19);
    ledger.ingest('m1', [withMinutes('s1', D19, [61, 62])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(2);
  });

  it('files reported minutes under the day they belong to', () => {
    ledger.ingest('m1', [withMinutes('s1', D18, [1, 2, 3])], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).activeMinutes).toBe(3);
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(0);
  });

  it('falls back to its own coarse minute for a collector that reports none', () => {
    const startedAt = TODAY_19 - 1000;
    ledger.ingest('m1', [legacy('s1', tokens(1), startedAt)], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(2), startedAt)], TODAY_19 + 10_000); // same minute
    ledger.ingest('m1', [legacy('s1', tokens(3), startedAt)], TODAY_19 + 61_000); // next minute
    ledger.ingest(
      'm1',
      [{ ...legacy('s1', tokens(4), startedAt), state: 'waiting' }],
      TODAY_19 + 121_000,
    ); // not working
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(2);
  });

  it('stops guessing minutes once the collector reports them exactly', () => {
    // The session is `working` and the wall clock says minute 720, but the
    // collector said minute 61 — adding the guess would inflate an exact
    // number with an approximate one.
    ledger.ingest('m1', [withMinutes('s1', D19, [61])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(1);
  });

  // ------------------------------------------------------------ derived tallies

  it('derives sessions run from distinct sessions rather than a counter', () => {
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'm', 1)]), bucketed('s2', [bucket(D19, 'm', 1)])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).sessionsRun).toBe(2);
  });

  it('does not grow sessions run by re-sending the same sessions', () => {
    const snap = [bucketed('s1', [bucket(D19, 'm', 1)]), bucketed('s2', [bucket(D19, 'm', 1)])];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m1', snap, TODAY_19 + 1000);
    ledger.ingest('m1', snap, TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).sessionsRun).toBe(2);
  });

  it('counts a session against the day it actually worked', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 5)])], DAY_18);
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 5), bucket(D19, 'm', 5)])], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).sessionsRun).toBe(1);
    expect(ledger.todayFor('m1', TODAY_19).sessionsRun).toBe(1);
  });

  // ------------------------------------------------------------------- cost

  it('estimates cost when every model in the day is priced', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, PRICED, 1_000_000)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).estimatedCostUsd).toBe(1);
  });

  it('surfaces null rather than a partial total when one model is unpriced', () => {
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, PRICED, 1_000_000), bucket(D19, 'mystery-model', 1_000_000)])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).estimatedCostUsd).toBeNull();
  });

  it('costs a day with no usage at nothing rather than nothing-known', () => {
    expect(ledger.todayFor('m1', TODAY_19).estimatedCostUsd).toBe(0);
  });

  // ---------------------------------------------------------------- hygiene

  it('keeps members separate', () => {
    db.prepare(
      `INSERT INTO members
         (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('m2', 'w1', 's', 'Other', 'mochi', 'member', 'active', DAY_18, DAY_18);
    const snap = [bucketed('shared-id', [bucket(D19, 'm', 100)])];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m2', snap, TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(100);
    expect(ledger.todayFor('m2', TODAY_19).tokens.input).toBe(100);
  });

  it('ignores sessions with neither buckets nor a cumulative total', () => {
    const bare: SessionSnapshot = {
      id: 'no-tokens',
      harness: 'codex',
      state: 'waiting',
      startedAt: TODAY_19 - 1000,
      lastActivityAt: TODAY_19,
    };
    expect(ledger.ingest('m1', [bare], TODAY_19)).toBe(false);
    expect(ledger.todayFor('m1', TODAY_19).sessionsRun).toBe(0);
  });

  it('reports change only when something actually changed', () => {
    const snap = [bucketed('s1', [bucket(D19, 'm', 100)])];
    expect(ledger.ingest('m1', snap, TODAY_19)).toBe(true);
    // Same buckets, same minute, still working → nothing left to record.
    expect(ledger.ingest('m1', snap, TODAY_19 + 1000)).toBe(false);
  });
});
