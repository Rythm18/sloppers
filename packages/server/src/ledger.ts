import {
  addTokens,
  type DailyStats,
  emptyTokens,
  type SessionSnapshot,
  type TokenTotals,
} from '@sloppers/protocol';
import type { Db } from './db/index.js';

/**
 * Turns cumulative per-session token totals into per-day, per-member stats
 * without ever double-counting. Each (session, member) has a watermark row;
 * only the monotonic delta above the watermark is folded into the day. A
 * re-sent snapshot produces a zero delta; a collector restart re-reports
 * the same cumulative totals and likewise adds nothing.
 *
 * Storage is the bucketed schema from migration 002 — `usage_watermarks` and
 * `daily_usage` are keyed by day *and* model — but collectors do not report
 * buckets yet, so everything written here lands under the model `unknown` and
 * the day the snapshot arrived. Task 15 teaches the ledger to read real
 * buckets; the tables are already shaped for it.
 */
const UNKNOWN_MODEL = 'unknown';

/** A day's activity bitmap: one bit per minute of a 1440-minute day. */
const MINUTE_BITMAP_BYTES = 180;

function popcount(bitmap: Buffer): number {
  let total = 0;
  for (const byte of bitmap) {
    let b = byte;
    while (b !== 0) {
      total += b & 1;
      b >>= 1;
    }
  }
  return total;
}

export class TokenLedger {
  constructor(private db: Db) {}

  /** Local calendar day, YYYY-MM-DD. */
  static dayOf(now: number): string {
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /**
   * Fold a snapshot into the ledger. Returns true if today's stats changed
   * (callers use this to know when to re-broadcast the leaderboard).
   */
  ingest(memberIdValue: string, sessions: SessionSnapshot[], now: number): boolean {
    const day = TokenLedger.dayOf(now);
    let changed = false;

    // The watermark chain is per (session, member) and spans days: growth
    // reported today is measured against whatever was last seen, whenever
    // that was. The row is then rewritten under today's date so the day a
    // delta belongs to is the day it was observed.
    const getWatermark = this.db.prepare(`
      SELECT input, output, cache_read, cache_write FROM usage_watermarks
      WHERE session_id = ? AND member_id = ? AND model = ?
      ORDER BY updated_at DESC LIMIT 1
    `);
    const upsertWatermark = this.db.prepare(`
      INSERT INTO usage_watermarks
        (session_id, member_id, day, model, harness, input, output, cache_read, cache_write, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, member_id, day, model) DO UPDATE SET
        harness = excluded.harness,
        input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        updated_at = excluded.updated_at
    `);
    const bumpDay = this.db.prepare(`
      INSERT INTO daily_usage
        (member_id, day, harness, model, input, output, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(member_id, day, harness, model) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write
    `);

    // Half of an invariant whose other half lives in the collector: it stops
    // deduplicating a resumed session once its claim is 24h old, and this guard
    // takes over from there. The two only meet without a gap while this day is
    // no longer than 24h — true under UTC, which is what the container runs.
    // Setting TZ to a zone with DST would stretch one day a year to 25h and
    // open a one-hour seam in which a resume is counted twice.
    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const tx = this.db.transaction(() => {
      for (const session of sessions) {
        if (!session.tokens) continue;
        const row = getWatermark.get(session.id, memberIdValue, UNKNOWN_MODEL) as
          | { input: number; output: number; cache_read: number; cache_write: number }
          | undefined;
        const isNewSession = row === undefined;
        // A session first seen now but started on an earlier day carries
        // history that doesn't belong to today: start its watermark at the
        // current totals so only growth from here counts.
        const watermark: TokenTotals = row
          ? {
              input: row.input,
              output: row.output,
              cacheRead: row.cache_read,
              cacheWrite: row.cache_write,
            }
          : isNewSession && session.startedAt < startOfToday
            ? { ...session.tokens }
            : emptyTokens();
        const delta: TokenTotals = {
          input: Math.max(0, session.tokens.input - watermark.input),
          output: Math.max(0, session.tokens.output - watermark.output),
          cacheRead: Math.max(0, session.tokens.cacheRead - watermark.cacheRead),
          cacheWrite: Math.max(0, session.tokens.cacheWrite - watermark.cacheWrite),
        };
        const hasDelta =
          delta.input > 0 || delta.output > 0 || delta.cacheRead > 0 || delta.cacheWrite > 0;
        // A shrinking cumulative (harness reset/rollback) lowers the
        // watermark so later growth counts again; nothing is subtracted.
        const shrank =
          session.tokens.input < watermark.input ||
          session.tokens.output < watermark.output ||
          session.tokens.cacheRead < watermark.cacheRead ||
          session.tokens.cacheWrite < watermark.cacheWrite;
        if (isNewSession || hasDelta || shrank) {
          upsertWatermark.run(
            session.id,
            memberIdValue,
            day,
            UNKNOWN_MODEL,
            session.harness,
            session.tokens.input,
            session.tokens.output,
            session.tokens.cacheRead,
            session.tokens.cacheWrite,
            now,
          );
          bumpDay.run(
            memberIdValue,
            day,
            session.harness,
            UNKNOWN_MODEL,
            delta.input,
            delta.output,
            delta.cacheRead,
            delta.cacheWrite,
          );
          changed = true;
        }
      }

      // One active minute per wall-clock minute in which anything worked.
      // The bitmap is the source of truth rather than a counter, so a restart
      // (or a re-sent snapshot) can never inflate the total.
      if (sessions.some((s) => s.state === 'working')) {
        const minute = Math.floor((now - startOfToday) / 60_000);
        if (this.markMinute(memberIdValue, day, minute)) changed = true;
      }
    });
    tx();
    return changed;
  }

  /** Set one minute's bit. Returns true if it wasn't already set. */
  private markMinute(memberIdValue: string, day: string, minuteOfDay: number): boolean {
    if (minuteOfDay < 0 || minuteOfDay >= MINUTE_BITMAP_BYTES * 8) return false;
    const bitmap = this.minuteBitmap(memberIdValue, day);
    const index = minuteOfDay >> 3;
    const mask = 1 << (minuteOfDay & 7);
    if (((bitmap[index] ?? 0) & mask) !== 0) return false;
    bitmap[index] = (bitmap[index] ?? 0) | mask;
    this.db
      .prepare(`
        INSERT INTO daily_activity (member_id, day, minutes) VALUES (?, ?, ?)
        ON CONFLICT(member_id, day) DO UPDATE SET minutes = excluded.minutes
      `)
      .run(memberIdValue, day, bitmap);
    return true;
  }

  /** Always a full-length buffer, whatever the stored blob's length. */
  private minuteBitmap(memberIdValue: string, day: string): Buffer {
    const row = this.db
      .prepare('SELECT minutes FROM daily_activity WHERE member_id = ? AND day = ?')
      .get(memberIdValue, day) as { minutes: Buffer } | undefined;
    const bitmap = Buffer.alloc(MINUTE_BITMAP_BYTES);
    if (row) Buffer.from(row.minutes).copy(bitmap, 0, 0, MINUTE_BITMAP_BYTES);
    return bitmap;
  }

  todayFor(memberIdValue: string, now: number): DailyStats {
    const day = TokenLedger.dayOf(now);
    const rows = this.db
      .prepare(
        'SELECT input, output, cache_read, cache_write FROM daily_usage WHERE member_id = ? AND day = ?',
      )
      .all(memberIdValue, day) as {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
    }[];
    let tokens = emptyTokens();
    for (const row of rows) {
      tokens = addTokens(tokens, {
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
      });
    }
    // Sessions run today are the sessions with a watermark written today —
    // derived rather than counted, so it can't drift from the usage rows.
    const sessions = this.db
      .prepare(
        'SELECT COUNT(DISTINCT session_id) AS n FROM usage_watermarks WHERE member_id = ? AND day = ?',
      )
      .get(memberIdValue, day) as { n: number };
    return {
      tokens,
      sessionsRun: sessions.n,
      activeMinutes: popcount(this.minuteBitmap(memberIdValue, day)),
    };
  }
}
