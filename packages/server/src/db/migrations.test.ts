import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { Migration } from './migrations.js';
import { migrations, runMigrations } from './migrations.js';

describe('migration runner', () => {
  it('applies every migration to a fresh database and records the version', () => {
    const db = new Database(':memory:');
    const version = runMigrations(db);
    expect(version).toBe(migrations.length);
    expect(db.pragma('user_version', { simple: true }) as number).toBe(migrations.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).toContain('members');
  });

  it('is a no-op on an already-migrated database', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toBe(migrations.length);
  });

  it('applies only the migrations a partially-migrated database is missing', () => {
    const db = new Database(':memory:');
    const first = migrations[0];
    if (!first) throw new Error('no migrations');
    db.transaction(() => first.up(db))();
    db.pragma('user_version = 1');
    expect(runMigrations(db)).toBe(migrations.length);
  });

  it('leaves foreign key enforcement ON after returning', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1);
  });

  it('leaves foreign key enforcement ON and user_version unchanged when a migration throws', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const versionBefore = migrations.length;
    const broken: Migration = {
      version: versionBefore + 1,
      name: 'broken',
      up() {
        throw new Error('boom');
      },
    };
    migrations.push(broken);
    try {
      expect(() => runMigrations(db)).toThrow(/migration \d+ \(broken\) failed: boom/);
    } finally {
      migrations.pop();
    }
    expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1);
    // The version bump lives inside the same transaction as up() and the
    // foreign_key_check, so a migration that throws before either of those
    // succeed must leave user_version exactly where the last successful
    // migration left it — never advanced for the one that failed.
    expect(db.pragma('user_version', { simple: true }) as number).toBe(versionBefore);
  });

  it('rolls back a migration entirely when it leaves a foreign key violation', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const versionBefore = migrations.length;
    const bad: Migration = {
      version: versionBefore + 1,
      name: 'dangling-reference',
      up(db) {
        // Foreign keys are off during the migration loop, so creating this
        // table and inserting a dangling reference both succeed at the
        // time — foreign_key_check, run inside the same transaction, must
        // still catch it and roll everything in this migration back.
        db.exec(`
          CREATE TABLE orphaned_by_bad_migration (
            id TEXT PRIMARY KEY,
            member_id TEXT NOT NULL REFERENCES members(id)
          );
        `);
        db.exec(
          "INSERT INTO orphaned_by_bad_migration (id, member_id) VALUES ('x', 'no-such-member')",
        );
      },
    };
    migrations.push(bad);
    try {
      expect(() => runMigrations(db)).toThrow(
        /migration \d+ \(dangling-reference\) failed: left foreign key violations in: orphaned_by_bad_migration/,
      );
    } finally {
      migrations.pop();
    }
    // The whole migration — including the table it created — must be
    // rolled back, not just left un-recorded.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    expect(tables.map((t) => t.name)).not.toContain('orphaned_by_bad_migration');
    expect(db.pragma('user_version', { simple: true }) as number).toBe(versionBefore);
    expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1);
  });
});
