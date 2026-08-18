import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

/**
 * All durable state in one SQLite file. Live world state — positions,
 * sockets, current sessions — is in-memory only and self-heals from
 * collector snapshots after a restart.
 */
export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  // runMigrations owns the foreign_keys pragma's lifecycle end to end
  // (OFF for the migration loop, ON once it returns) — setting it here too
  // would just be redundant dead work.
  runMigrations(db);
  return db;
}

export { migrations, runMigrations } from './migrations.js';
