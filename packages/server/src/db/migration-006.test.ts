import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations } from './migrations.js';

/**
 * Migration 006 adds `last_present_at` — when a *browser* of this member was
 * last in the office — because `last_seen_at` is written by collector hellos
 * too, and "your laptop reported overnight" is not "you were here".
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

describe('migration 006', () => {
  it('backfills presence from last_seen_at, erring toward no greeting', () => {
    // Deleting the backfill leaves every existing member at 0 — an absence of
    // fifty-six years, so the whole server is greeted on its first reload
    // after the deploy. Seeding from `last_seen_at` over-estimates presence
    // for anybody whose value came from a collector, which errs the other
    // way: one missed greeting, not a spurious one for everyone.
    const db = dbAtVersion(5);
    db.prepare(
      `INSERT INTO workspaces (id, name, invite_code, settings, created_at)
       VALUES ('w1', 'lab', 'lab-abc', '{}', 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO members
         (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at)
       VALUES ('m1', 'w1', 's', 'Dev', 'pixel', 'owner', 'active', 1000, 123456789)`,
    ).run();
    expect(runMigrations(db)).toBe(migrations.length);

    const row = db.prepare('SELECT last_present_at FROM members').get() as {
      last_present_at: number;
    };
    expect(row.last_present_at).toBe(123456789);
    db.close();
  });

  it('is a no-op the second time', () => {
    const db = dbAtVersion(5);
    expect(runMigrations(db)).toBe(migrations.length);
    expect(runMigrations(db)).toBe(migrations.length);
    db.close();
  });
});
