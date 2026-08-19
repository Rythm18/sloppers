import { randomBytes } from 'node:crypto';
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
  {
    version: 2,
    name: 'workspaces-roles-and-bucketed-usage',
    up(db) {
      db.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          invite_code TEXT NOT NULL UNIQUE,
          settings TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE members_new (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          secret TEXT NOT NULL,
          display_name TEXT NOT NULL,
          avatar TEXT NOT NULL,
          role TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE workspace_events (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          at INTEGER NOT NULL,
          actor_id TEXT,
          action TEXT NOT NULL,
          target_id TEXT,
          detail TEXT
        );
        CREATE TABLE usage_watermarks (
          session_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          day TEXT NOT NULL,
          model TEXT NOT NULL,
          harness TEXT NOT NULL,
          input INTEGER NOT NULL, output INTEGER NOT NULL,
          cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (session_id, member_id, day, model)
        );
        CREATE TABLE daily_usage (
          member_id TEXT NOT NULL,
          day TEXT NOT NULL,
          harness TEXT NOT NULL,
          model TEXT NOT NULL,
          input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
          cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (member_id, day, harness, model)
        );
        CREATE TABLE daily_activity (
          member_id TEXT NOT NULL,
          day TEXT NOT NULL,
          minutes BLOB NOT NULL,
          PRIMARY KEY (member_id, day)
        );
        -- Sessions already counted under the old session-keyed watermarks.
        -- Their first bucketed report seeds instead of counting.
        CREATE TABLE legacy_sessions (
          session_id TEXT NOT NULL,
          member_id TEXT NOT NULL,
          PRIMARY KEY (session_id, member_id)
        );
      `);

      // Random, not derived from the invite code: the id is meant to
      // outlive code rotation, so it must not let a holder (e.g. a banned
      // member who captured it before rotation) reconstruct a pre-rotation
      // code. Same construction as the rest of the codebase's identifiers
      // (see ids.ts's memberId) but inlined — migrations are frozen once
      // shipped, so they don't reach into code that might later change.
      const randomWorkspaceId = () => `w_${randomBytes(8).toString('hex')}`;

      const defaults = JSON.stringify({ joinMode: 'link', publicLeaderboard: false });
      const rooms = db.prepare('SELECT code, name, created_at FROM rooms').all() as {
        code: string;
        name: string;
        created_at: number;
      }[];
      const insertWorkspace = db.prepare(
        'INSERT INTO workspaces (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      const idFor = new Map<string, string>();
      for (const room of rooms) {
        const id = randomWorkspaceId();
        idFor.set(room.code, id);
        insertWorkspace.run(id, room.name || room.code, room.code, defaults, room.created_at);
      }

      const members = db
        .prepare('SELECT * FROM members ORDER BY room_code, created_at, id')
        .all() as {
        id: string;
        room_code: string;
        secret: string;
        display_name: string;
        avatar: string;
        created_at: number;
        last_seen_at: number;
      }[];
      const insertMember = db.prepare(
        'INSERT INTO members_new (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const ownerSeen = new Set<string>();
      for (const m of members) {
        let workspaceId = idFor.get(m.room_code);
        if (!workspaceId) {
          // Unreachable on a healthy database — the version-1 schema has
          // members.room_code REFERENCES rooms(code) — but foreign keys are
          // OFF for the whole migration loop, so don't bet data loss on
          // that holding. Salvage the member (and anything referencing
          // them, e.g. devices) into a workspace synthesized from their
          // orphaned room code instead of silently dropping the row.
          workspaceId = randomWorkspaceId();
          idFor.set(m.room_code, workspaceId);
          insertWorkspace.run(workspaceId, m.room_code, m.room_code, defaults, m.created_at);
          console.error(
            `migration 002: synthesized workspace ${workspaceId} for orphaned room code ${JSON.stringify(m.room_code)} (member ${m.id})`,
          );
        }
        const role = ownerSeen.has(m.room_code) ? 'member' : 'owner';
        ownerSeen.add(m.room_code);
        insertMember.run(
          m.id,
          workspaceId,
          m.secret,
          m.display_name,
          m.avatar,
          role,
          'active',
          m.created_at,
          m.last_seen_at,
        );
      }

      db.exec(`
        INSERT INTO daily_usage (member_id, day, harness, model, input, output, cache_read, cache_write)
        SELECT member_id, day, harness, 'unknown', input, output, cache_read, cache_write
        FROM daily_stats;
        INSERT INTO legacy_sessions (session_id, member_id)
        SELECT session_id, member_id FROM session_watermarks;
        DROP TABLE daily_stats;
        DROP TABLE session_watermarks;
        DROP TABLE members;
        DROP TABLE rooms;
      `);
      db.exec('ALTER TABLE members_new RENAME TO members');
      db.exec(`
        CREATE UNIQUE INDEX members_workspace_name
          ON members(workspace_id, lower(display_name)) WHERE status = 'active';
        CREATE INDEX members_workspace ON members(workspace_id);
        CREATE INDEX workspace_events_ws ON workspace_events(workspace_id, at);
      `);
    },
  },
  {
    version: 3,
    name: 'retired-usage-watermarks',
    up(db) {
      // A session's spend is attributed one of two ways: under the model
      // `unknown` by the flat 0.1.1 path, or under real model names by the
      // bucketed one. When a collector switches, the ledger re-bases onto the
      // new scheme and the old scheme's watermarks must stop being consulted.
      //
      // Marked rather than deleted, because these rows carry a second meaning
      // the ledger cannot reconstruct: `sessionsRun` counts distinct sessions
      // per day off exactly this table, and the days a retired row covers are
      // not always the days the new scheme reports (the flat path files under
      // the *server's* day, the bucketed path under the collector's, and for
      // anyone not on UTC those differ). Deleting them makes a day read
      // "1000 tokens, 0 sessions".
      db.exec('ALTER TABLE usage_watermarks ADD COLUMN retired INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 4,
    name: 'flat-watermark-sentinel',
    up(db) {
      // The flat 0.1.1 path used to key its watermark under the model
      // `unknown`, on the assumption that nothing else writes that name. That
      // was wrong: the collector files unattributed spend under exactly
      // `unknown` (`UNKNOWN_MODEL` in its `core/types.ts`), so an ordinary
      // Codex report looked like a collector upgrade on every heartbeat.
      //
      // The empty string replaces it, and cannot collide: `usageBucketSchema`
      // declares `model: z.string().min(1)`, so a bucket carrying it is
      // rejected before it reaches the ledger.
      //
      // A blanket rewrite is safe because at this moment every `unknown`
      // watermark row is flat-era by construction. `usage_watermarks` is
      // created empty by migration 002 — that migration backfills `daily_usage`
      // and `legacy_sessions`, and never inserts here — and the only writer
      // since has been a ledger that read `session.tokens` alone and hardcoded
      // `unknown`. The bucketed writer, which is what can produce a genuine
      // `unknown` model row, has not shipped.
      //
      // Rewriting cannot collide on the primary key
      // (session_id, member_id, day, model): nothing has ever written the
      // empty-string model, so no target row exists.
      db.exec("UPDATE usage_watermarks SET model = '' WHERE model = 'unknown'");

      // A shrinking cumulative lowers a watermark but never lowers
      // `daily_usage`, so past a shrink the watermark no longer says how much
      // has been banked. The re-basing path measures recovery against it and
      // would invent the gap, so it needs to know.
      db.exec('ALTER TABLE usage_watermarks ADD COLUMN shrunk INTEGER NOT NULL DEFAULT 0');
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
 *
 * PRAGMA user_version is, unlike PRAGMA foreign_keys, an ordinary
 * transactional write — so the version bump lives inside the same
 * transaction as up() and the foreign_key_check, and commits or rolls back
 * atomically with them. A crash between "migration committed" and "version
 * bumped" could otherwise re-run a migration that isn't safe to re-run;
 * inside one transaction that window doesn't exist.
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
          db.pragma(`user_version = ${migration.version}`);
        })();
      } catch (error) {
        throw new Error(
          `migration ${migration.version} (${migration.name}) failed: ${(error as Error).message}`,
        );
      }
      version = migration.version;
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
  return version;
}
