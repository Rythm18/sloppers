import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations } from './migrations.js';

/**
 * Migration 005 adds the per-bucket `banked_*` columns, which record how much
 * a (session, day, model) actually contributed to `daily_usage` — not the same
 * as its watermark, since a seeded bucket carries a watermark it never banked.
 */

/** A database at the version a shipped server would have left it. */
function dbAtVersion(version: number): Database.Database {
  const db = new Database(':memory:');
  for (const migration of migrations.slice(0, version)) {
    db.transaction(() => migration.up(db))();
  }
  db.pragma(`user_version = ${version}`);
  return db;
}

describe('migration 005', () => {
  it('defaults an existing watermark to having banked nothing', () => {
    // Conservative on purpose: a row from before this column existed reports
    // no contribution, so un-banking it takes nothing back rather than
    // guessing at a figure the database never recorded.
    const db = dbAtVersion(4);
    db.prepare(
      `INSERT INTO usage_watermarks
         (session_id, member_id, day, model, harness, input, output, cache_read, cache_write, updated_at)
       VALUES ('s1', 'm1', '2026-08-19', 'gpt-5', 'codex', 1000, 0, 0, 0, 1000)`,
    ).run();
    expect(runMigrations(db)).toBe(migrations.length);

    const row = db
      .prepare(
        `SELECT input, banked_input, banked_output, banked_cache_read, banked_cache_write
         FROM usage_watermarks`,
      )
      .get() as Record<string, number>;
    expect(row).toEqual({
      input: 1000,
      banked_input: 0,
      banked_output: 0,
      banked_cache_read: 0,
      banked_cache_write: 0,
    });
  });

  it('applies to a database that has never run any migration', () => {
    // Which is what production is: `main` carries no migration runner at all,
    // so the live database is at user_version 0 and runs the whole chain.
    const db = new Database(':memory:');
    expect(runMigrations(db)).toBe(migrations.length);
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
  });

  it('is a no-op on a database already at the latest version', () => {
    const db = dbAtVersion(migrations.length);
    expect(runMigrations(db)).toBe(migrations.length);
  });
});
