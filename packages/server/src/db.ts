import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/**
 * All durable state in one SQLite file: identities (members, device keys,
 * pairing codes) and the token ledger (watermarks, daily stats). Live world
 * state — positions, sockets, current sessions — is in-memory only and
 * self-heals from collector snapshots after a restart.
 */
export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL REFERENCES rooms(code),
      secret TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
    CREATE TABLE IF NOT EXISTS session_watermarks (
      session_id TEXT NOT NULL,
      member_id TEXT NOT NULL REFERENCES members(id),
      harness TEXT NOT NULL,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, member_id)
    );
    CREATE TABLE IF NOT EXISTS daily_stats (
      member_id TEXT NOT NULL REFERENCES members(id),
      day TEXT NOT NULL,
      harness TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      sessions_run INTEGER NOT NULL DEFAULT 0,
      active_minutes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (member_id, day, harness)
    );
  `);
  return db;
}
