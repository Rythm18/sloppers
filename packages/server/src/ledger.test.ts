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

/** A minute before each day's noon: a session that plainly started that day. */
const STARTED_18 = DAY_18 - 60_000;
const STARTED_19 = TODAY_19 - 60_000;

/**
 * Started today by default, which is the ordinary case; the seeding guard
 * fires on sessions that started earlier, so those pass their own `startedAt`.
 */
const baseSession = {
  harness: 'claude-code',
  state: 'working',
  startedAt: STARTED_19,
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
 * The shape a real 0.2 collector actually puts on the wire, which none of the
 * single-field helpers above reproduce: `SessionTracker.snapshot` sets
 * `tokens` *and* `usage` *and* `activeMinutes` on the same snapshot. `tokens`
 * is summed over every bucket before the 30-bucket wire cap, so it can exceed
 * the buckets it ships with — pass `flat` to model that.
 */
function realistic(
  id: string,
  usage: UsageBucket[],
  opts: {
    flat?: TokenTotals;
    minutes?: { day: string; minutes: number[] };
    startedAt?: number;
  } = {},
): SessionSnapshot {
  const summed = usage.reduce(
    (acc, b) => ({
      input: acc.input + b.input,
      output: acc.output + b.output,
      cacheRead: acc.cacheRead + b.cacheRead,
      cacheWrite: acc.cacheWrite + b.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const out: SessionSnapshot = {
    ...baseSession,
    id,
    tokens: opts.flat ?? summed,
    usage,
    ...(opts.startedAt === undefined ? {} : { startedAt: opts.startedAt }),
  };
  if (opts.minutes) {
    out.activeMinutes = [{ day: opts.minutes.day, minutes: encodeMinutes(opts.minutes.minutes) }];
  }
  return out;
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
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'claude-opus-5', 60)], STARTED_18)], DAY_18);
    ledger.ingest(
      'm1',
      [
        bucketed(
          's1',
          [bucket(D18, 'claude-opus-5', 100, 10), bucket(D19, 'claude-opus-5', 40, 4)],
          STARTED_18,
        ),
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
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 100)], STARTED_18)], DAY_18);
    // Still running after midnight: yesterday's bucket is restated unchanged
    // and a fresh one opens for today.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D18, 'm', 100), bucket(D19, 'm', 30)], STARTED_18)],
      TODAY_19,
    );
    // Late work attributed back to yesterday still lands on yesterday.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D18, 'm', 120), bucket(D19, 'm', 80)], STARTED_18)],
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
    // The server runs UTC (node:22-alpine, no TZ set anywhere). A collector
    // east of UTC legitimately reports tomorrow. Nothing about that looks
    // like a replay, and it is filed on the day the collector named.
    ledger.ingest('m1', [bucketed('s1', [bucket(D20, 'm', 90)])], TODAY_19);
    expect(ledger.todayFor('m1', new Date(2026, 7, 20, 12, 0).getTime()).tokens.input).toBe(90);
  });

  it('absorbs a resume whose replay is dated on the server’s own today', () => {
    // The mirror of the case a day comparison catches, and the reason there
    // is no day comparison. A collector east of UTC stamps work done in the
    // server's evening with what is already tomorrow locally, so a replay of
    // it carries the server's *today* as its bucket day — `day < today` is
    // false and the whole replay is banked a second time.
    ledger.ingest('m1', [bucketed('s-orig', [bucket(D19, 'm', 1_000_000)], STARTED_18)], DAY_18);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1_000_000);

    // Days later, past any claim the collector still holds: a new session id
    // over the same replayed bucket.
    ledger.ingest(
      'm1',
      [bucketed('s-resume', [bucket(D19, 'm', 1_000_000)], STARTED_18)],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1_000_000);
  });

  // ------------------------------------------ changing attribution mid-session

  it('does not re-bank a live session when the collector upgrades to buckets', () => {
    // 0.1.1 is the published collector and files everything under `unknown`.
    ledger.ingest('m1', [legacy('s1', tokens(1000, 100))], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    // The user upgrades mid-session. The same spend comes back attributed to
    // a real model, against which there is no watermark — so it would be
    // banked all over again.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000, 100)])],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    // Growth after the transition counts, exactly once.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 1400, 100)])],
      TODAY_19 + 2000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1400);
  });

  it('does not re-bank a live session when the collector downgrades to flat totals', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000, 100)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    ledger.ingest('m1', [legacy('s1', tokens(1000, 100))], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    ledger.ingest('m1', [legacy('s1', tokens(1400, 100))], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1400);
  });

  it('re-bases only once, so a settled session keeps counting normally', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 1000);
    // Three more bucketed reports: the transition is spent, so these are
    // ordinary deltas rather than three more seedings.
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1100)])], TODAY_19 + 2000);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1200)])], TODAY_19 + 3000);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1300)])], TODAY_19 + 4000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1300);
  });

  it('re-bases once, then banks buckets the session opens later', () => {
    // The re-basing has to be *retired*, not just applied. A bucket opened
    // after the transition — a second model, or the next day — has no
    // watermark of its own, so a transition still considered live would seed
    // it and lose the spend outright.
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 1000);
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000), bucket(D19, 'claude-haiku-4-5', 250)])],
      TODAY_19 + 2000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1250);
  });

  it('does not re-bank flat-era growth when the collector upgrades back', () => {
    // The flip-flop that matters is the one with *growth in each era*. A
    // constant total through all four reports pins the shape of the bug but
    // never the bug: the stale per-model watermark only bites when the flat
    // era moved the total past it.
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19 + 1000);
    // 500 spent while the collector spoke flat, banked under `unknown`.
    ledger.ingest('m1', [legacy('s1', tokens(1500))], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1500);

    // Back to buckets. The per-model watermark still reads 1000, so the same
    // 500 is banked a second time unless it was retired on the way down.
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1500)])], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1500);
  });

  it('keeps sessions run consistent with the usage when attribution changes', () => {
    // The flat path files under the *server's* day; the collector's own day
    // may differ (it is east or west of UTC). Retiring the flat watermark
    // must not orphan the day it banked on, or a day reads "1000 tokens,
    // 0 sessions" and contradicts how `sessionsRun` is documented.
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D20, 'claude-opus-5', 1000)])], TODAY_19 + 1000);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(1000);
    expect(today.sessionsRun).toBe(1);
  });

  it('recovers spend that happened while the collector was down for the upgrade', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000, 100))], TODAY_19);
    // Stopped, upgraded, restarted. 900 more input was spent in between, and
    // the first bucketed report is the only evidence it ever happened.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 1900, 150)])],
      TODAY_19 + 1000,
    );
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(1900);
    expect(today.tokens.output).toBe(150);
  });

  it('recovers downtime spend across a downgrade too', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(1600))], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1600);
  });

  it('recovers nothing when the first bucketed report totals less than the flat watermark', () => {
    // The wire caps `usage` at 30 buckets while the flat total is summed
    // before capping, so the first bucketed report can legitimately total
    // less than what was already banked. That is not a refund, and it is not
    // downtime spend either.
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 600)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('measures the upgrade against the last flat total, not every day’s', () => {
    // The flat path rewrites its watermark under each server day it is seen
    // on, and every one of those rows holds the whole session cumulative —
    // so summing them would invent spend that was never made. The latest row
    // is the one that means "accounted for".
    ledger.ingest('m1', [legacy('s1', tokens(1000), STARTED_18)], DAY_18);
    ledger.ingest('m1', [legacy('s1', tokens(1500), STARTED_18)], TODAY_19);
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 2000)], STARTED_18)],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(1000);
    // 500 banked during the flat era, plus 500 recovered at the transition.
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('does not mistake a collector’s own unknown-model bucket for the flat sentinel', () => {
    // `unknown` is a model name the *shipped* collector emits: `addUsage`
    // files spend under it whenever a harness reports tokens before naming a
    // model, which 26 of 493 local Codex rollouts do for a third of their
    // tokens. If that collides with the flat path's sentinel, every heartbeat
    // looks like an upgrade and the named-model tokens are re-banked forever.
    const snap = [realistic('s1', [bucket(D19, 'unknown', 1000), bucket(D19, 'gpt-5', 500)])];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m1', snap, TODAY_19 + 1000);
    ledger.ingest('m1', snap, TODAY_19 + 2000);
    ledger.ingest('m1', snap, TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1500);
  });

  it('upgrades cleanly when the first bucketed report includes an unknown bucket', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    const snap = [
      realistic('s1', [bucket(D19, 'unknown', 600), bucket(D19, 'claude-opus-5', 400)]),
    ];
    ledger.ingest('m1', snap, TODAY_19 + 1000);
    ledger.ingest('m1', snap, TODAY_19 + 2000);
    ledger.ingest('m1', snap, TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('keeps counting an all-unknown bucketed session', () => {
    // The whole session can be unattributed — a Codex multi-agent thread that
    // never emits an early `turn_context` looks exactly like this.
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1000)])], TODAY_19);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1400)])], TODAY_19 + 1000);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1400)])], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1400);
    expect(ledger.todayFor('m1', TODAY_19).byModel?.unknown?.input).toBe(1400);
  });

  it('stays ineligible for recovery after a shrink, even once it grows again', () => {
    // A shrink is a harness reset on a *live* session, so the next heartbeat
    // normally shows growth. If growth clears the ineligibility, the guard
    // only ever covers a transition landing on the single heartbeat after the
    // shrink — which is the rare case, not the common one.
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(300))], TODAY_19 + 1000);
    // One token of growth.
    ledger.ingest('m1', [legacy('s1', tokens(301))], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1001);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1001);
  });

  it('stays ineligible after more than one shrink', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(300))], TODAY_19 + 1000);
    ledger.ingest('m1', [legacy('s1', tokens(200))], TODAY_19 + 2000);
    ledger.ingest('m1', [legacy('s1', tokens(250))], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1050);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 4000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1050);
  });

  it('remembers a shrink recorded on an earlier day', () => {
    // Crossing midnight writes a *new* watermark row, so the shrink and the
    // transition can sit on different rows entirely.
    ledger.ingest('m1', [legacy('s1', tokens(1000), STARTED_18)], DAY_18);
    ledger.ingest('m1', [legacy('s1', tokens(300), STARTED_18)], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(900), STARTED_18)], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(600);

    ledger.ingest(
      'm1',
      [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)], { startedAt: STARTED_18 })],
      TODAY_19 + 2000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(600);
  });

  it('does not launder a shrink through a scheme transition', () => {
    // Retiring the flat rows must not erase the shrink history with them, or
    // the *second* transition recovers against a watermark that was never
    // trustworthy.
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [legacy('s1', tokens(300))], TODAY_19 + 1000);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    // Back down to flat, reporting a much larger cumulative.
    ledger.ingest('m1', [legacy('s1', tokens(2000))], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('remembers a shrink that happened in the bucketed era', () => {
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 400)])], TODAY_19 + 1000);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 500)])], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1100);

    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1100);
  });

  it('records exactly what a monotone session spent, whatever shape it speaks', () => {
    // The hand-written cases above are sequences I thought of, and three
    // rounds of defects came from sequences I did not. This one is generated,
    // and its invariant is absolute rather than relative: for a session whose
    // cumulative only ever rises, the day's total *is* the final cumulative —
    // no seeding applies (it started today), nothing is forfeited, and no
    // amount of switching between the flat and bucketed shapes may change it.
    //
    // Deliberately not "the flipped run matches the unflipped run": that
    // baseline is itself inflated after a reset, by the pre-existing shrink
    // convention, so it would have accepted the very defect this round fixed.
    let seed = 0x2b7e1516;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    // Includes `unknown`, which the shipped collector really emits.
    const models = ['claude-opus-5', 'unknown', 'gpt-5'];

    for (let trial = 0; trial < 200; trial++) {
      const steps = 3 + rand(6);
      // Strictly rising, so the truth is unambiguous.
      const walk: number[] = [];
      let value = 0;
      for (let i = 0; i < steps; i++) {
        value += 1 + rand(500);
        walk.push(value);
      }
      // A fresh shape decision each heartbeat: upgrades, downgrades, flapping.
      const shapes = walk.map(() => rand(2) === 0);
      const first = models[rand(models.length)] ?? 'claude-opus-5';
      // Sometimes split the cumulative across two models. A single-model walk
      // cannot expose a sentinel collision — the collision only inflates when
      // the retired slice covers one bucket while the report totals several —
      // and an earlier version of this test used one model and missed exactly
      // that. The split ratio is fixed per trial, so each bucket stays
      // monotone and the invariant below still holds.
      const second = rand(2) === 0 ? null : (models[rand(models.length)] ?? 'gpt-5');
      const bucketsFor = (total: number): UsageBucket[] => {
        if (second === null || second === first) return [bucket(D19, first, total)];
        const half = Math.floor(total / 2);
        return [bucket(D19, first, half), bucket(D19, second, total - half)];
      };

      const dbRun = openDb(':memory:');
      const led = new TokenLedger(dbRun);
      walk.forEach((total, i) => {
        led.ingest(
          'm1',
          [shapes[i] ? realistic('s1', bucketsFor(total)) : legacy('s1', tokens(total))],
          TODAY_19 + i * 1000,
        );
      });
      const recorded = led.todayFor('m1', TODAY_19).tokens.input;
      dbRun.close();

      expect(recorded).toBe(walk.at(-1));
    }
  });

  it('recovers nothing at a transition whose flat watermark had shrunk', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    // A harness reset drops the cumulative. The ledger lowers the watermark
    // and subtracts nothing, so `daily_usage` still holds the full 1000 —
    // which means the watermark no longer says how much has been banked.
    ledger.ingest('m1', [legacy('s1', tokens(300))], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    // Measuring the upgrade against it would invent 700.
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 2000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  // --------------------------------------------------- buckets that migrate

  it('does not double-count a bucket that migrated to another model', () => {
    // The collector's `removeUsage` unwinds a restated request from the bucket
    // it first landed in and deletes that bucket when it empties — so a
    // session's reported set can lose a key entirely. Codex does this
    // routinely: spend is filed under `unknown` until `turn_context` names the
    // model, and 26 of 493 local rollouts take that path.
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1000)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'gpt-5', 1000)])], TODAY_19 + 1000);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(1000);
    // ...and it moved, rather than being split across both names.
    expect(today.byModel?.unknown).toBeUndefined();
    expect(today.byModel?.['gpt-5']?.input).toBe(1000);
  });

  it('does not double-count a bucket that migrated to another day', () => {
    // A request restated after midnight moves between day keys the same way.
    ledger.ingest('m1', [realistic('s1', [bucket(D18, 'gpt-5', 1000)])], TODAY_19);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(1000);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'gpt-5', 1000)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(0);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('handles a partial migration that merges into a surviving bucket', () => {
    ledger.ingest(
      'm1',
      [realistic('s1', [bucket(D19, 'unknown', 1000), bucket(D19, 'gpt-5', 500)])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1500);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'gpt-5', 1500)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1500);
  });

  it('leaves another session’s spend alone when one session’s bucket migrates', () => {
    // Both sessions bank into the same `(day, model)` row, so un-banking must
    // remove only what the migrating session put there.
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1000)])], TODAY_19);
    ledger.ingest('m1', [realistic('s2', [bucket(D19, 'unknown', 300)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1300);

    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'gpt-5', 1000)])], TODAY_19 + 2000);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(1300);
    expect(today.byModel?.unknown?.input).toBe(300);
    expect(today.byModel?.['gpt-5']?.input).toBe(1000);
  });

  it('does not un-bank a bucket the wire cap merely dropped', () => {
    // `tokens` is summed over every bucket before the 30-bucket cap, so a
    // report whose buckets total less than `tokens` is *incomplete* — the
    // missing keys still exist on the collector. Treating them as migrated
    // would erase real spend on every heartbeat of a long session.
    ledger.ingest(
      'm1',
      [realistic('s1', [bucket(D18, 'gpt-5', 400), bucket(D19, 'gpt-5', 600)])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(400);

    // The next heartbeat ships only the newest bucket, with `tokens` still
    // describing both.
    ledger.ingest(
      'm1',
      [realistic('s1', [bucket(D19, 'gpt-5', 600)], { flat: tokens(1000) })],
      TODAY_19 + 1000,
    );
    expect(ledger.todayFor('m1', DAY_18).tokens.input).toBe(400);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(600);
  });

  it('does not let a migrated-away model keep the day’s cost unknown', () => {
    // Un-banking leaves the old model's row at zero. If a zeroed row still
    // counted as a model in the day, an unpriced one would null the cost for
    // the rest of the day even though nothing was ever spent under it.
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1_000_000)])], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).estimatedCostUsd).toBeNull();

    ledger.ingest('m1', [realistic('s1', [bucket(D19, PRICED, 1_000_000)])], TODAY_19 + 1000);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(1_000_000);
    expect(today.estimatedCostUsd).toBe(1);
  });

  it('re-banks a bucket that comes back after migrating away', () => {
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'unknown', 1000)])], TODAY_19);
    ledger.ingest('m1', [realistic('s1', [bucket(D19, 'gpt-5', 1000)])], TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
    // The same key returning is new spend against a cleared slate, not a
    // restatement of what was un-banked.
    ledger.ingest(
      'm1',
      [realistic('s1', [bucket(D19, 'gpt-5', 1000), bucket(D19, 'unknown', 200)])],
      TODAY_19 + 2000,
    );
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1200);
  });

  // ------------------------------------------- the shape the wire really has

  it('handles tokens, buckets and minutes arriving together, as they really do', () => {
    // Every 0.2 snapshot carries all three at once. The single-field helpers
    // used elsewhere in this file are convenient and are not what ships.
    const snap = [
      realistic('s1', [bucket(D19, 'claude-opus-5', 400, 40)], {
        minutes: { day: D19, minutes: [61, 62] },
      }),
    ];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m1', snap, TODAY_19 + 1000);
    const today = ledger.todayFor('m1', TODAY_19);
    expect(today.tokens.input).toBe(400);
    expect(today.activeMinutes).toBe(2);
    expect(today.sessionsRun).toBe(1);
  });

  it('banks the buckets, not the flat total, when the wire cap makes them differ', () => {
    // `tokens` is summed before the 30-bucket cap, so it legitimately exceeds
    // the buckets shipped alongside it. The buckets are what carry a day.
    const snap = [realistic('s1', [bucket(D19, 'claude-opus-5', 1000)], { flat: tokens(5000) })];
    ledger.ingest('m1', snap, TODAY_19);
    ledger.ingest('m1', snap, TODAY_19 + 1000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
  });

  it('survives a collector flip-flopping between the two shapes', () => {
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 1000);
    ledger.ingest('m1', [legacy('s1', tokens(1000))], TODAY_19 + 2000);
    ledger.ingest('m1', [bucketed('s1', [bucket(D19, 'claude-opus-5', 1000)])], TODAY_19 + 3000);
    expect(ledger.todayFor('m1', TODAY_19).tokens.input).toBe(1000);
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

  it('does not stamp its own day on a collector that speaks in buckets', () => {
    // The fallback files under the *server's* day (UTC in production) at the
    // server's minute-of-day; a 0.2 collector files under its own local day
    // at its own minute. Mixing the two mislabels a non-UTC member's
    // activity, so a snapshot carrying bucketed data at all is never
    // supplemented with a guess — even when it reports no minutes.
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 10)], STARTED_18)], TODAY_19);
    expect(ledger.todayFor('m1', TODAY_19).activeMinutes).toBe(0);
    expect(ledger.todayFor('m1', DAY_18).activeMinutes).toBe(0);
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

  it('counts one session once however many models it used', () => {
    // Watermarks are per (session, day, model), so a two-model session leaves
    // two rows on one day. Counting rows rather than distinct sessions would
    // report two sessions run.
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D19, 'claude-opus-5', 1), bucket(D19, 'claude-haiku-4-5', 1)])],
      TODAY_19,
    );
    expect(ledger.todayFor('m1', TODAY_19).sessionsRun).toBe(1);
  });

  it('counts a session against the day it actually worked', () => {
    ledger.ingest('m1', [bucketed('s1', [bucket(D18, 'm', 5)], STARTED_18)], DAY_18);
    ledger.ingest(
      'm1',
      [bucketed('s1', [bucket(D18, 'm', 5), bucket(D19, 'm', 5)], STARTED_18)],
      TODAY_19,
    );
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
