import {
  addTokens,
  type DailyStats,
  emptyTokens,
  type SessionSnapshot,
  type TokenTotals,
} from '@sloppers/protocol';
import type { Db } from './db.js';

/**
 * Turns cumulative per-session token totals into per-day, per-member stats
 * without ever double-counting. Each (session, member) has a watermark row;
 * only the monotonic delta above the watermark is folded into the day. A
 * re-sent snapshot produces a zero delta; a collector restart re-reports
 * the same cumulative totals and likewise adds nothing.
 */
export class TokenLedger {
  private lastActiveMinute = new Map<string, number>();

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

    const getWatermark = this.db.prepare(
      'SELECT input, output, cache_read, cache_write FROM session_watermarks WHERE session_id = ? AND member_id = ?',
    );
    const upsertWatermark = this.db.prepare(`
      INSERT INTO session_watermarks
        (session_id, member_id, harness, input, output, cache_read, cache_write, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, member_id) DO UPDATE SET
        input = excluded.input, output = excluded.output,
        cache_read = excluded.cache_read, cache_write = excluded.cache_write,
        updated_at = excluded.updated_at
    `);
    const bumpDay = this.db.prepare(`
      INSERT INTO daily_stats
        (member_id, day, harness, input, output, cache_read, cache_write, sessions_run, active_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(member_id, day, harness) DO UPDATE SET
        input = input + excluded.input,
        output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write,
        sessions_run = sessions_run + excluded.sessions_run
    `);

    const startOfToday = new Date(now).setHours(0, 0, 0, 0);
    const tx = this.db.transaction(() => {
      for (const session of sessions) {
        if (!session.tokens) continue;
        const row = getWatermark.get(session.id, memberIdValue) as
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
            session.harness,
            session.tokens.input,
            session.tokens.output,
            session.tokens.cacheRead,
            session.tokens.cacheWrite,
            now,
          );
          // Count a session toward "sessions run today" only when its first
          // sighting actually moves tokens: a pre-existing session being
          // seeded, or a resumed transcript whose copied history was
          // deduplicated away, is not a new session run.
          bumpDay.run(
            memberIdValue,
            day,
            session.harness,
            delta.input,
            delta.output,
            delta.cacheRead,
            delta.cacheWrite,
            isNewSession && hasDelta ? 1 : 0,
          );
          changed = true;
        }
      }

      // One active minute per wall-clock minute in which anything worked.
      if (sessions.some((s) => s.state === 'working')) {
        const minute = Math.floor(now / 60_000);
        if (this.lastActiveMinute.get(memberIdValue) !== minute) {
          this.lastActiveMinute.set(memberIdValue, minute);
          const harness = sessions.find((s) => s.state === 'working')?.harness ?? 'unknown';
          this.db
            .prepare(`
              INSERT INTO daily_stats (member_id, day, harness, active_minutes)
              VALUES (?, ?, ?, 1)
              ON CONFLICT(member_id, day, harness) DO UPDATE SET
                active_minutes = active_minutes + 1
            `)
            .run(memberIdValue, day, harness);
          changed = true;
        }
      }
    });
    tx();
    return changed;
  }

  todayFor(memberIdValue: string, now: number): DailyStats {
    const day = TokenLedger.dayOf(now);
    const rows = this.db
      .prepare(
        'SELECT input, output, cache_read, cache_write, sessions_run, active_minutes FROM daily_stats WHERE member_id = ? AND day = ?',
      )
      .all(memberIdValue, day) as {
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      sessions_run: number;
      active_minutes: number;
    }[];
    let tokens = emptyTokens();
    let sessionsRun = 0;
    let activeMinutes = 0;
    for (const row of rows) {
      tokens = addTokens(tokens, {
        input: row.input,
        output: row.output,
        cacheRead: row.cache_read,
        cacheWrite: row.cache_write,
      });
      sessionsRun += row.sessions_run;
      activeMinutes += row.active_minutes;
    }
    return { tokens, sessionsRun, activeMinutes };
  }
}
