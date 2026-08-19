import {
  addTokens,
  countMinutes,
  type DailyStats,
  dayOf,
  decodeMinutes,
  emptyTokens,
  estimateCostUsd,
  MINUTES_PER_DAY,
  type SessionSnapshot,
  type TokenTotals,
  type UsageBucket,
} from '@sloppers/protocol';
import type { Db } from './db/index.js';

/**
 * Turns what collectors report into per-day, per-member stats without ever
 * double-counting.
 *
 * A 0.2 collector reports `usage`: totals bucketed by the day and model the
 * work actually happened on, cumulative *within each bucket*. Each
 * (session, member, day, model) has a watermark row and only the monotonic
 * growth above it is folded into that day, so a re-sent snapshot or a
 * collector restart adds exactly nothing and work is credited to the day it
 * was done rather than the day it was seen.
 *
 * A 0.1.1 collector — still the published one — reports only the flat,
 * session-cumulative `tokens`. That is synthesized into a single
 * `(today, 'unknown')` bucket, and because the total spans days its watermark
 * is read forward across the day boundary rather than keyed to one day.
 *
 * `activeMinutes` reports are 1440-bit bitmaps per day. They are ORed into
 * the member's stored bitmap for that day, so two sessions sharing a minute
 * count it once and a re-send changes nothing. A collector too old to report
 * them falls back to the server's own coarse mark — one bit for the minute a
 * snapshot arrives in while anything is working — so the current day is never
 * blank whoever is reporting. The two are never mixed for one member, because
 * they cut days on different clocks; see `ingest`.
 *
 * ## What the wire caps cost, now that this reads buckets
 *
 * `sessionSnapshotSchema` caps `usage` at 30 buckets and `activeMinutes` at 7
 * days, and the collector sorts both newest-day-first so the cap drops the
 * oldest. On the local corpus (532 grouped sessions) bucket counts peak at 27,
 * but 9 sessions exceed 7 active days, the longest at 25.
 *
 * **Buckets lose nothing.** For a session the server already tracks, a bucket
 * that falls out of the cap simply stops being restated, and not restating a
 * finished day adds zero — exactly like re-sending it. For a session the
 * server has never seen, either it started before today, in which case every
 * one of its buckets is seeded rather than banked (see `foldUsage`) and the
 * dropped ones were never going to be counted; or it started today, in which
 * case it has a handful of buckets and cannot approach 30.
 *
 * **Minutes do lose history, and there is no way to get it back.** Minute
 * bitmaps have no seeding rule — an unreported day is simply absent, not
 * declined — so a cold start on a session past its 7th active day never sends
 * days 8+ and the server never learns them. Today's minutes are safe (newest
 * first), and nothing currently displays any day but today, so the loss is
 * invisible right now; it would surface the moment a history view exists.
 * Raising the cap is a protocol change and an expensive one — each day is
 * ~240 base64 characters per session, so 25 days across the wire's 64 sessions
 * is ~380KB every heartbeat — which is not worth paying for history nothing
 * reads. Deliberately unfixed, not overlooked.
 */

/** Where a flat cumulative total lands: we don't know which model spent it. */
const UNKNOWN_MODEL = 'unknown';

/** A day's activity bitmap: one bit per minute of a 1440-minute day. */
const MINUTE_BITMAP_BYTES = MINUTES_PER_DAY / 8;

interface UsageRow {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

function totalsOf(row: UsageRow): TokenTotals {
  return {
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
  };
}

function bucketTotals(b: UsageBucket): TokenTotals {
  return { input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite };
}

function prepare(db: Db) {
  return {
    /**
     * The watermark for exactly this bucket; how bucketed usage is measured.
     * Retired rows are invisible to every lookup below — they are kept only
     * so `sessionsRun` still knows this session ran on their day.
     */
    bucketWatermark: db.prepare(`
      SELECT input, output, cache_read, cache_write FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND day = ? AND model = ? AND retired = 0
    `),
    /**
     * The newest watermark for this session/model on *any* day. Only the flat
     * `tokens` path uses it: that total is cumulative for the whole session,
     * so a session running across midnight must be measured against whatever
     * was last seen, whenever that was, or the whole running total would be
     * re-banked on the new day.
     *
     * "Newest", never a sum: the flat path rewrites this row under each server
     * day it is seen on, and every one of those rows holds the whole session
     * cumulative. Adding them together would invent spend.
     */
    carriedWatermark: db.prepare(`
      SELECT input, output, cache_read, cache_write FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND model = ? AND retired = 0
      ORDER BY updated_at DESC, day DESC LIMIT 1
    `),
    /**
     * Has this session ever been banked against, on any day, for any model?
     * Retired rows count: the question is whether we know this session, and
     * a re-based session is one we have been tracking all along.
     */
    sessionSeen: db.prepare(`
      SELECT 1 AS seen FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? LIMIT 1
    `),
    /**
     * Does this session hold live watermarks written by the flat path?
     * Nothing else ever writes the model `unknown`: both adapters take the
     * model name from the transcript, and migration 002's `unknown` backfill
     * went to `daily_usage`, not here. So this is exactly "the collector was
     * speaking 0.1.1 for this session".
     */
    flatWatermark: db.prepare(`
      SELECT 1 AS seen FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND model = ? AND retired = 0 LIMIT 1
    `),
    /** ...and the converse: live watermarks written by the bucketed path. */
    modelWatermark: db.prepare(`
      SELECT 1 AS seen FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND model <> ? AND retired = 0 LIMIT 1
    `),
    /**
     * The session's cumulative across its live bucket watermarks. A sum is
     * right here and wrong for `carriedWatermark`: bucket rows are cumulative
     * *within* their own (day, model) and so are disjoint, while flat rows
     * each restate the whole session.
     */
    modelWatermarkTotal: db.prepare(`
      SELECT
        COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(cache_read), 0) AS cache_read,
        COALESCE(SUM(cache_write), 0) AS cache_write
      FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND model <> ? AND retired = 0
    `),
    retireFlatWatermarks: db.prepare(`
      UPDATE usage_watermarks SET retired = 1
      WHERE session_id = ? AND member_id = ? AND model = ?
    `),
    retireModelWatermarks: db.prepare(`
      UPDATE usage_watermarks SET retired = 1
      WHERE session_id = ? AND member_id = ? AND model <> ?
    `),
    legacySession: db.prepare(
      'SELECT 1 AS seen FROM legacy_sessions WHERE session_id = ? AND member_id = ?',
    ),
    forgetLegacySession: db.prepare(
      'DELETE FROM legacy_sessions WHERE session_id = ? AND member_id = ?',
    ),
    // `retired = 0` on both paths: writing a watermark under a key is what
    // makes it live again, so a scheme the session comes back to un-retires
    // the exact rows it reuses.
    upsertWatermark: db.prepare(`
      INSERT INTO usage_watermarks
        (session_id, member_id, day, model, harness, input, output, cache_read, cache_write, updated_at, retired)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(session_id, member_id, day, model) DO UPDATE SET
        harness = excluded.harness,
        input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        updated_at = excluded.updated_at, retired = 0
    `),
    bumpDay: db.prepare(`
      INSERT INTO daily_usage
        (member_id, day, harness, model, input, output, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_id, day, harness, model) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write
    `),
    readBitmap: db.prepare('SELECT minutes FROM daily_activity WHERE member_id = ? AND day = ?'),
    writeBitmap: db.prepare(`
      INSERT INTO daily_activity (member_id, day, minutes) VALUES (?, ?, ?)
      ON CONFLICT(member_id, day) DO UPDATE SET minutes = excluded.minutes
    `),
    /** A day's usage collapsed per model; the harness split is not displayed. */
    dayByModel: db.prepare(`
      SELECT model,
             SUM(input) AS input, SUM(output) AS output,
             SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
      FROM daily_usage WHERE member_id = ? AND day = ?
      GROUP BY model
    `),
    daySessions: db.prepare(`
      SELECT COUNT(DISTINCT session_id) AS n FROM usage_watermarks
      WHERE member_id = ? AND day = ?
    `),
  };
}

export class TokenLedger {
  /**
   * Local calendar day, YYYY-MM-DD — the protocol's own `dayOf`, so the
   * server cuts days exactly the way collectors do. The server uses it only
   * to decide which day *it* is serving as "today"; work is filed under the
   * day the collector stamped on the bucket, never under this one.
   */
  static readonly dayOf = dayOf;

  private readonly q: ReturnType<typeof prepare>;

  constructor(private db: Db) {
    this.q = prepare(db);
  }

  /**
   * Fold a snapshot into the ledger. Returns true if anything was recorded
   * (callers use this to know when to re-broadcast the leaderboard).
   */
  ingest(memberIdValue: string, sessions: SessionSnapshot[], now: number): boolean {
    const today = dayOf(now);
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    let changed = false;

    // The server's coarse "something is working right now" mark is a fallback
    // for collectors too old to report bitmaps, and it files under the
    // *server's* day at the server's minute-of-day, while a 0.2 collector
    // files under its own local day at its own minute. Those two disagree for
    // any member not on UTC, so they must never be mixed for one member.
    //
    // The gate is therefore "did this snapshot carry any bucketed data at
    // all", not "did it report minutes": a 0.2 collector whose sessions have
    // usage but no minutes yet would otherwise pick up a server-day mark. A
    // pure 0.1.1 snapshot has neither field, and everything about it — usage
    // included — is already filed under the server's day, so it stays
    // internally consistent. It cannot be made to *agree* with the collector's
    // clock, because the 0.1.1 wire carries no offset to agree with.
    //
    // A member sharing nothing (`tokens: false` strips both fields) lands in
    // the same branch and keeps coarse minutes, which is the intent.
    const speaksBuckets = sessions.some(
      (s) => s.usage !== undefined || s.activeMinutes !== undefined,
    );

    const tx = this.db.transaction(() => {
      for (const session of sessions) {
        if (this.foldUsage(memberIdValue, session, today, startOfToday, now)) changed = true;
        for (const report of session.activeMinutes ?? []) {
          if (this.mergeMinutes(memberIdValue, report.day, decodeMinutes(report.minutes))) {
            changed = true;
          }
        }
      }
      if (!speaksBuckets && sessions.some((s) => s.state === 'working')) {
        const minute = Math.floor((now - startOfToday) / 60_000);
        if (this.markMinute(memberIdValue, today, minute)) changed = true;
      }
    });
    tx();
    return changed;
  }

  /** One session's usage, whichever shape it arrived in. */
  private foldUsage(
    memberIdValue: string,
    session: SessionSnapshot,
    today: string,
    startOfToday: number,
    now: number,
  ): boolean {
    const reported = session.usage;
    const bucketed = reported !== undefined && reported.length > 0;
    const buckets: UsageBucket[] = bucketed
      ? reported
      : session.tokens
        ? [{ day: today, model: UNKNOWN_MODEL, ...session.tokens }]
        : [];
    if (buckets.length === 0) return false;

    const seen = this.q.sessionSeen.get(session.id, memberIdValue) !== undefined;
    // A session the *old*, session-keyed ledger already banked. Its first
    // bucketed report restates history the daily totals already contain, so
    // it seeds; the marker is then consumed so the next report counts.
    const alreadyBanked =
      !seen && this.q.legacySession.get(session.id, memberIdValue) !== undefined;

    // Half of an invariant whose other half lives in the collector: the
    // collector drops a resumed request while the original's claim is under
    // 24h old, and this guard absorbs everything older.
    //
    // `--resume` replays a transcript verbatim under a NEW session id, so the
    // server sees an unfamiliar session whose watermark is absent and would
    // otherwise seed at zero and bank the whole replay a second time. Per-day
    // buckets alone do not save it: they put the double on the right day
    // instead of on today, which is tidier and still twice.
    //
    // The test is `startedAt` alone, deliberately. A resume copy inherits the
    // original's first timestamp (see `claim` in the claude-code adapter), so
    // it is always old; a session that genuinely started minutes ago never is.
    //
    // Also comparing the *bucket's* day against today looks like it would
    // narrow this usefully, and it is unsafe in one direction. The server runs
    // UTC (node:22-alpine, no TZ set anywhere; `primary_region` is geography,
    // not a clock), days are cut on the collector's clock by design, and a
    // collector east of UTC stamps work done in the server's evening with what
    // is already tomorrow locally. A replay of that carries the server's own
    // `today`, sails past `day < today`, and is banked a second time. Nothing
    // on the wire carries the collector's offset, so the server cannot tell
    // that date apart from a genuine one.
    //
    // The cost of leaving it out is real, and is the conservative direction: a
    // session that started before today and is first seen now has its
    // already-completed work for today seeded rather than backfilled, so it
    // counts only from this moment on. That is what shipped before buckets
    // existed, and on a number people compete over, understating beats
    // overstating.
    const startedEarlier = session.startedAt < startOfToday;

    // Changing how a session's spend is *attributed* is not new spend. The
    // flat path banks under `unknown`, the bucketed path under real model
    // names, and neither watermark can see the other — so a collector upgrade
    // mid-session restates the same cumulative under a key with no watermark
    // and banks it all over again. 0.1.1 is the published version, so this
    // happens to every user who upgrades, for whatever sessions are live at
    // that moment. Downgrading does the same in reverse.
    //
    // Re-base instead of banking: seed the new attribution at its reported
    // values, exactly as a `legacy_sessions` row does. The spend was already
    // counted under the old scheme; only growth from here should count.
    const hasFlat =
      this.q.flatWatermark.get(session.id, memberIdValue, UNKNOWN_MODEL) !== undefined;
    const hasModel =
      this.q.modelWatermark.get(session.id, memberIdValue, UNKNOWN_MODEL) !== undefined;
    const rebasing = bucketed ? hasFlat : hasModel && !hasFlat;

    let changed = false;
    if (rebasing) {
      // Retirement is symmetric, and it has to be. Leaving the other scheme's
      // rows live does not "let a later re-upgrade re-base off them" — an
      // existing watermark row outranks `seed` below, so the re-base would be
      // a no-op in exactly the case it is needed. Concretely: buckets 1000 →
      // flat 1000 → flat 1500 → buckets 1500 banks the flat era's 500 twice,
      // because the stale per-model row still reads 1000.
      //
      // Retired, not deleted: `sessionsRun` counts distinct sessions per day
      // off this table, and the days a retired row covers are not always the
      // days the new scheme reports — the flat path files under the server's
      // day, the bucketed path under the collector's. Deleting would leave a
      // day reading "1000 tokens, 0 sessions".
      //
      // The old scheme's cumulative, before it goes: the latest flat row
      // (each restates the whole session) or the sum of the bucket rows (each
      // covers its own slice).
      const accounted = (
        bucketed
          ? this.q.carriedWatermark.get(session.id, memberIdValue, UNKNOWN_MODEL)
          : this.q.modelWatermarkTotal.get(session.id, memberIdValue, UNKNOWN_MODEL)
      ) as UsageRow | undefined;
      if (bucketed) this.q.retireFlatWatermarks.run(session.id, memberIdValue, UNKNOWN_MODEL);
      else this.q.retireModelWatermarks.run(session.id, memberIdValue, UNKNOWN_MODEL);

      // Spend that happened while the collector was stopped for the upgrade
      // would otherwise vanish: the seed adopts the first report's cumulative
      // wholesale, so everything above the last accounted point is written off.
      // That loss is bounded only by how long the collector was down.
      //
      // Recovering it cannot double-count. The reported total is never more
      // than the session's true cumulative, and `accounted` is exactly how
      // much of that has already been banked, so the difference is at most the
      // genuine unbanked growth — and `max(0, ·)` per field means a report
      // that totals *less* (the 30-bucket cap is applied after the flat total
      // is summed, so this is normal) recovers nothing rather than inventing a
      // refund.
      //
      // It is filed under `unknown` on the day it arrived, and that is the
      // honest place for it: we know the amount and genuinely do not know the
      // day or the model it belongs to. Spreading it across the reported
      // buckets would be a guess dressed as data, and would price tokens we
      // cannot attribute. Under `unknown` the day's `estimatedCostUsd` goes
      // null, which is the correct answer.
      const previous = accounted ? totalsOf(accounted) : emptyTokens();
      const reported = buckets.reduce((sum, b) => addTokens(sum, bucketTotals(b)), emptyTokens());
      const recovered: TokenTotals = {
        input: Math.max(0, reported.input - previous.input),
        output: Math.max(0, reported.output - previous.output),
        cacheRead: Math.max(0, reported.cacheRead - previous.cacheRead),
        cacheWrite: Math.max(0, reported.cacheWrite - previous.cacheWrite),
      };
      if (
        recovered.input > 0 ||
        recovered.output > 0 ||
        recovered.cacheRead > 0 ||
        recovered.cacheWrite > 0
      ) {
        this.q.bumpDay.run(
          memberIdValue,
          today,
          session.harness,
          UNKNOWN_MODEL,
          recovered.input,
          recovered.output,
          recovered.cacheRead,
          recovered.cacheWrite,
        );
        changed = true;
      }
    }

    for (const b of buckets) {
      const day = bucketed ? b.day : today;
      const row = (
        bucketed
          ? this.q.bucketWatermark.get(session.id, memberIdValue, b.day, b.model)
          : this.q.carriedWatermark.get(session.id, memberIdValue, b.model)
      ) as UsageRow | undefined;
      // Keyed on the *session* being unknown, not on this bucket's watermark
      // being absent: a session we already bank against is a session we are
      // tracking, and a day it opens later is genuine backfill, not a replay.
      // `rebasing` is the one case a *known* session seeds — see above.
      const seed = rebasing || (!seen && (alreadyBanked || startedEarlier));
      const watermark: TokenTotals = row ? totalsOf(row) : seed ? bucketTotals(b) : emptyTokens();
      const delta: TokenTotals = {
        input: Math.max(0, b.input - watermark.input),
        output: Math.max(0, b.output - watermark.output),
        cacheRead: Math.max(0, b.cacheRead - watermark.cacheRead),
        cacheWrite: Math.max(0, b.cacheWrite - watermark.cacheWrite),
      };
      const grew =
        delta.input > 0 || delta.output > 0 || delta.cacheRead > 0 || delta.cacheWrite > 0;
      // A shrinking cumulative (harness reset/rollback) lowers the watermark
      // so later growth counts again; nothing is ever subtracted.
      const shrank =
        b.input < watermark.input ||
        b.output < watermark.output ||
        b.cacheRead < watermark.cacheRead ||
        b.cacheWrite < watermark.cacheWrite;
      if (row !== undefined && !grew && !shrank) continue;
      this.q.upsertWatermark.run(
        session.id,
        memberIdValue,
        day,
        b.model,
        session.harness,
        b.input,
        b.output,
        b.cacheRead,
        b.cacheWrite,
        now,
      );
      if (grew) {
        this.q.bumpDay.run(
          memberIdValue,
          day,
          session.harness,
          b.model,
          delta.input,
          delta.output,
          delta.cacheRead,
          delta.cacheWrite,
        );
      }
      changed = true;
    }
    if (alreadyBanked) this.q.forgetLegacySession.run(session.id, memberIdValue);
    return changed;
  }

  /**
   * OR a reported bitmap into the day's stored one. Returns true if any bit
   * was newly set — the bitmap is the source of truth rather than a counter,
   * so overlapping sessions, re-sends and restarts can never inflate it.
   */
  private mergeMinutes(memberIdValue: string, day: string, incoming: Uint8Array): boolean {
    const bitmap = this.minuteBitmap(memberIdValue, day);
    let changed = false;
    for (let i = 0; i < MINUTE_BITMAP_BYTES; i++) {
      const merged = (bitmap[i] ?? 0) | (incoming[i] ?? 0);
      if (merged !== bitmap[i]) {
        bitmap[i] = merged;
        changed = true;
      }
    }
    if (changed) this.q.writeBitmap.run(memberIdValue, day, bitmap);
    return changed;
  }

  /** Set one minute's bit. Returns true if it wasn't already set. */
  private markMinute(memberIdValue: string, day: string, minuteOfDayValue: number): boolean {
    if (minuteOfDayValue < 0 || minuteOfDayValue >= MINUTES_PER_DAY) return false;
    const one = Buffer.alloc(MINUTE_BITMAP_BYTES);
    one[minuteOfDayValue >> 3] = 1 << (minuteOfDayValue & 7);
    return this.mergeMinutes(memberIdValue, day, one);
  }

  /** Always a full-length buffer, whatever the stored blob's length. */
  private minuteBitmap(memberIdValue: string, day: string): Buffer {
    const row = this.q.readBitmap.get(memberIdValue, day) as { minutes: Buffer } | undefined;
    const bitmap = Buffer.alloc(MINUTE_BITMAP_BYTES);
    if (row) Buffer.from(row.minutes).copy(bitmap, 0, 0, MINUTE_BITMAP_BYTES);
    return bitmap;
  }

  todayFor(memberIdValue: string, now: number): DailyStats {
    const day = dayOf(now);
    const rows = this.q.dayByModel.all(memberIdValue, day) as ({ model: string } & UsageRow)[];
    let tokens = emptyTokens();
    const byModel: Record<string, TokenTotals> = {};
    // A day nobody worked costs nothing, which is a complete answer; one
    // unpriced model in a day that *was* worked makes the bill unknowable,
    // and a partial sum would read as a complete, smaller one.
    let estimatedCostUsd: number | null = 0;
    for (const row of rows) {
      const totals = totalsOf(row);
      byModel[row.model] = totals;
      tokens = addTokens(tokens, totals);
      const cost = estimateCostUsd(row.model, totals);
      estimatedCostUsd =
        cost === null || estimatedCostUsd === null ? null : estimatedCostUsd + cost;
    }
    // Sessions that worked this day, derived from the watermark rows filed
    // under it rather than counted, so it cannot drift from the usage.
    // Retired rows are included deliberately: a session whose attribution was
    // re-based still ran on the days its old watermarks covered, and those are
    // not always days the new scheme reports.
    const sessions = this.q.daySessions.get(memberIdValue, day) as { n: number };
    return {
      tokens,
      sessionsRun: sessions.n,
      activeMinutes: countMinutes(this.minuteBitmap(memberIdValue, day)),
      byModel,
      estimatedCostUsd,
    };
  }
}
