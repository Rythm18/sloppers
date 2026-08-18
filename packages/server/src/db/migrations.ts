import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

/**
 * Ordered, append-only. Each migration runs exactly once, inside a
 * transaction, tracked by SQLite's user_version pragma. Never edit a
 * migration that has shipped — add another.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'baseline',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          code TEXT PRIMARY KEY,
          name TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS members (
          id TEXT PRIMARY KEY,
          room_code TEXT NOT NULL REFERENCES rooms(code),
          secret TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS members_room_name
          ON members(room_code, lower(display_name));
        CREATE TABLE IF NOT EXISTS devices (
          key TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES members(id),
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pairings (
          code TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES members(id),
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relink_tokens (
          token TEXT PRIMARY KEY,
          member_id TEXT NOT NULL REFERENCES members(id),
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_watermarks (
          session_id TEXT NOT NULL,
          member_id TEXT NOT NULL REFERENCES members(id),
          harness TEXT NOT NULL,
          input INTEGER NOT NULL, output INTEGER NOT NULL,
          cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS daily_stats (
          member_id TEXT NOT NULL REFERENCES members(id),
          day TEXT NOT NULL,
          harness TEXT NOT NULL,
          input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          sessions_run INTEGER NOT NULL DEFAULT 0,
          active_minutes INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (member_id, day, harness)
        );
      `);
      // Databases predating the runner may already have these columns.
      const cols = (t: string) =>
        (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      if (!cols('members').includes('last_seen_at')) {
        db.exec('ALTER TABLE members ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0');
      }
      if (!cols('rooms').includes('name')) {
        db.exec("ALTER TABLE rooms ADD COLUMN name TEXT NOT NULL DEFAULT ''");
      }
    },
  },
];

/**
 * Apply every migration above the database's current version.
 *
 * Foreign key enforcement is turned OFF for the duration of the loop and
 * back ON afterward — both outside any transaction, since the pragma is
 * silently a no-op inside one. Migrations that reshape tables referenced by
 * foreign keys (e.g. dropping a table others reference) would otherwise
 * trigger SQLite's implicit delete-and-check on DROP TABLE and fail.
 *
 * PRAGMA foreign_key_check, unlike PRAGMA foreign_keys, is a query rather
 * than a setting, so it works correctly inside a transaction. It runs as
 * part of the same transaction as the migration's up() — if it finds a
 * violation, throwing from inside that transaction rolls the whole
 * migration back (its DDL and data are undone) and user_version is left
 * unchanged, so a retry re-runs the migration against an untouched
 * database instead of a partially applied one.
 */
export function runMigrations(db: Database.Database): number {
  let version = db.pragma('user_version', { simple: true }) as number;
  db.pragma('foreign_keys = OFF');
  try {
    for (const migration of migrations) {
      if (migration.version <= version) continue;
      try {
        db.transaction(() => {
          migration.up(db);
          const violations = db.pragma('foreign_key_check') as { table: string }[];
          if (violations.length > 0) {
            const tables = [...new Set(violations.map((v) => v.table))].join(', ');
            throw new Error(`left foreign key violations in: ${tables}`);
          }
        })();
      } catch (error) {
        throw new Error(
          `migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        );
      }
      db.pragma(`user_version = ${migration.version}`);
      version = migration.version;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return version;
}
