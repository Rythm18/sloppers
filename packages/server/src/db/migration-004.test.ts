import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations } from './migrations.js';

/**
 * Migration 004 re-keys the flat path's watermark off the model `unknown` and
 * onto the empty string, because `unknown` is a model name the collector
 * genuinely sends and the collision made every Codex heartbeat look like a
 * collector upgrade.
 *
 * The blanket rewrite is only safe because every `unknown` watermark row is
 * flat-era at the moment it runs. That is the claim these tests exercise
 * against a database built the way a deployed one actually was.
 */

/** A database in the shape a shipped server left it: schema at version 2. */
function deployedV2Db(): Database.Database {
  const db = new Database(':memory:');
  for (const migration of migrations.slice(0, 2)) {
    db.transaction(() => migration.up(db))();
  }
  db.pragma('user_version = 2');
  return db;
}

/** What the pre-bucket ledger wrote: everything under `unknown`, day-of-arrival. */
function insertFlatWatermark(
  db: Database.Database,
  sessionId: string,
  day: string,
  input: number,
): void {
  db.prepare(
    `INSERT INTO usage_watermarks
       (session_id, member_id, day, model, harness, input, output, cache_read, cache_write, updated_at)
     VALUES (?, ?, ?, 'unknown', 'claude-code', ?, 0, 0, 0, ?)`,
  ).run(sessionId, 'm1', day, input, 1000);
}

describe('migration 004', () => {
  it('re-keys a deployed flat watermark onto the wire-impossible sentinel', () => {
    const db = deployedV2Db();
    insertFlatWatermark(db, 'sess-1', '2026-08-19', 1000);
    expect(runMigrations(db)).toBe(migrations.length);

    const rows = db
      .prepare('SELECT session_id, model, input, retired, shrunk FROM usage_watermarks')
      .all() as {
      session_id: string;
      model: string;
      input: number;
      retired: number;
      shrunk: number;
    }[];
    expect(rows).toEqual([{ session_id: 'sess-1', model: '', input: 1000, retired: 0, shrunk: 0 }]);
  });

  it('leaves the `unknown` attribution in daily_usage alone', () => {
    // Only the *watermark* key moves. `daily_usage.model = 'unknown'` is how
    // unattributed spend is displayed, is shared with the collector, and is
    // what migration 002 backfilled — it must survive untouched.
    const db = deployedV2Db();
    db.prepare(
      `INSERT INTO daily_usage (member_id, day, harness, model, input, output, cache_read, cache_write)
       VALUES ('m1', '2026-08-19', 'claude-code', 'unknown', 4200, 0, 0, 0)`,
    ).run();
    runMigrations(db);
    const row = db.prepare("SELECT model, input FROM daily_usage WHERE member_id = 'm1'").get() as {
      model: string;
      input: number;
    };
    expect(row).toEqual({ model: 'unknown', input: 4200 });
  });

  it('rewrites every day a long-lived flat session accumulated', () => {
    // The flat path rewrites its watermark under each server day it is seen
    // on, so one session can hold several `unknown` rows. All of them are
    // flat-era and all must move together, or the leftovers keep matching.
    const db = deployedV2Db();
    insertFlatWatermark(db, 'sess-1', '2026-08-17', 500);
    insertFlatWatermark(db, 'sess-1', '2026-08-18', 900);
    insertFlatWatermark(db, 'sess-1', '2026-08-19', 1000);
    runMigrations(db);
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM usage_watermarks WHERE model = 'unknown'")
      .get() as { n: number };
    expect(left.n).toBe(0);
    const moved = db
      .prepare("SELECT COUNT(*) AS n FROM usage_watermarks WHERE model = ''")
      .get() as { n: number };
    expect(moved.n).toBe(3);
  });

  it('is a no-op on a database that has already run it', () => {
    const db = deployedV2Db();
    insertFlatWatermark(db, 'sess-1', '2026-08-19', 1000);
    runMigrations(db);
    const before = db.prepare('SELECT * FROM usage_watermarks').all();
    expect(runMigrations(db)).toBe(migrations.length);
    expect(db.prepare('SELECT * FROM usage_watermarks').all()).toEqual(before);
  });

  it('applies cleanly to an empty deployed database', () => {
    const db = deployedV2Db();
    expect(runMigrations(db)).toBe(migrations.length);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });
});
