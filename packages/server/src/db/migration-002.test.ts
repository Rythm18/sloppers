import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations, runMigrations } from './migrations.js';

/** Build a database in the version-1 shape with two rooms of members. */
function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  const first = migrations[0];
  if (!first) throw new Error('no migrations');
  db.transaction(() => first.up(db))();
  db.pragma('user_version = 1');
  db.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)').run(
    'the-lab-k4xp2q',
    'the lab',
    1000,
  );
  db.prepare('INSERT INTO rooms (code, name, created_at) VALUES (?, ?, ?)').run(
    'demo',
    'demo floor',
    900,
  );
  const insert = db.prepare(
    'INSERT INTO members (id, room_code, secret, display_name, avatar, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('m_first', 'the-lab-k4xp2q', 's1', 'ridham', 'pixel', 1100, 1100);
  insert.run('m_later', 'the-lab-k4xp2q', 's2', 'sam', 'mochi', 1200, 1200);
  insert.run('m_demo', 'demo', 's3', 'maya', 'juniper', 950, 950);
  db.prepare(
    'INSERT INTO session_watermarks (session_id, member_id, harness, input, output, cache_read, cache_write, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('sess-1', 'm_first', 'claude-code', 500, 100, 90, 10, 1300);
  db.prepare(
    'INSERT INTO daily_stats (member_id, day, harness, input, output, cache_read, cache_write, sessions_run, active_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('m_first', '2026-08-18', 'claude-code', 500, 100, 90, 10, 1, 12);
  return db;
}

describe('migration 002', () => {
  it('carries every room and member across, oldest member owning the workspace', () => {
    const db = legacyDb();
    runMigrations(db);

    const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY created_at').all() as {
      id: string;
      name: string;
      invite_code: string;
      settings: string;
    }[];
    expect(workspaces).toHaveLength(2);
    const lab = workspaces.find((w) => w.invite_code === 'the-lab-k4xp2q');
    expect(lab?.name).toBe('the lab');
    expect(JSON.parse(lab?.settings ?? '{}').joinMode).toBe('link');

    const members = db
      .prepare('SELECT id, role, status, workspace_id FROM members ORDER BY created_at')
      .all() as { id: string; role: string; status: string; workspace_id: string }[];
    expect(members).toHaveLength(3);
    expect(members.find((m) => m.id === 'm_first')?.role).toBe('owner');
    expect(members.find((m) => m.id === 'm_later')?.role).toBe('member');
    expect(members.find((m) => m.id === 'm_demo')?.role).toBe('owner');
    expect(members.every((m) => m.status === 'active')).toBe(true);
    expect(members.find((m) => m.id === 'm_first')?.workspace_id).toBe(lab?.id);
  });

  it('carries daily stats over as model "unknown" and records legacy sessions', () => {
    const db = legacyDb();
    runMigrations(db);
    const usage = db.prepare('SELECT * FROM daily_usage').all() as {
      model: string;
      input: number;
      member_id: string;
    }[];
    expect(usage).toHaveLength(1);
    expect(usage[0]?.model).toBe('unknown');
    expect(usage[0]?.input).toBe(500);

    const legacy = db.prepare('SELECT * FROM legacy_sessions').all() as {
      session_id: string;
      member_id: string;
    }[];
    expect(legacy).toEqual([{ session_id: 'sess-1', member_id: 'm_first' }]);
  });

  it('frees a name once a member is no longer active', () => {
    const db = legacyDb();
    runMigrations(db);
    const ws = db
      .prepare('SELECT id FROM workspaces WHERE invite_code = ?')
      .get('the-lab-k4xp2q') as { id: string } | undefined;
    db.prepare('UPDATE members SET status = ? WHERE id = ?').run('kicked', 'm_later');
    expect(() =>
      db
        .prepare(
          'INSERT INTO members (id, workspace_id, secret, display_name, avatar, role, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('m_new', ws?.id, 's4', 'sam', 'pixel', 'member', 'active', 1400, 1400),
    ).not.toThrow();
  });
});
