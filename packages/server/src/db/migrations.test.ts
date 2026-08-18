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

  it('leaves foreign key enforcement ON even when a migration throws', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const broken: Migration = {
      version: migrations.length + 1,
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
  });

  it('rejects a migration that leaves a dangling foreign key reference', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const versionBefore = migrations.length;
    const bad: Migration = {
      version: versionBefore + 1,
      name: 'dangling-reference',
      up(db) {
        // Foreign keys are off during the migration loop, so this insert of a
        // device pointing at a nonexistent member succeeds at insert time —
        // the post-migration foreign_key_check must still catch it.
        db.exec(
          "INSERT INTO devices (key, member_id, created_at) VALUES ('dangling-device', 'no-such-member', 0)",
        );
      },
    };
    migrations.push(bad);
    try {
      expect(() => runMigrations(db)).toThrow(
        /migration \d+ \(dangling-reference\) left foreign key violations in: devices/,
      );
    } finally {
      migrations.pop();
    }
    // The failed migration's version must not have been recorded.
    expect(db.pragma('user_version', { simple: true }) as number).toBe(versionBefore);
    expect(db.pragma('foreign_keys', { simple: true }) as number).toBe(1);
  });
});
